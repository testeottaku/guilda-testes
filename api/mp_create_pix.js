// api/mp_create_pix.js
// Vercel Serverless Function (CommonJS) — Node 24+ (fetch nativo)
// Segurança:
// - Exige Firebase ID Token (Authorization: Bearer ...)
// - UID/Email sempre vêm do token (não confia no body)
// - 1 solicitação por UID em /solicita/{uid}
// - Reutiliza o mesmo PIX quando status = pendente
// - Bloqueia trocar de plano enquanto houver pendente

const admin = require("firebase-admin");

function getEnv(name) {
  const v = process.env[name];
  return (v && String(v).trim()) || "";
}

function ensureAdmin() {
  if (admin.apps.length) return;

  const saRaw = getEnv("FIREBASE_SERVICE_ACCOUNT");
  if (!saRaw) throw new Error("FIREBASE_SERVICE_ACCOUNT ausente (ENV).");

  let sa;
  try {
    sa = JSON.parse(saRaw);
  } catch (e) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT inválido: JSON.parse falhou.");
  }

  // Corrige private_key caso venha com \\n
  if (sa.private_key && typeof sa.private_key === "string") {
    sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  }

  admin.initializeApp({
    credential: admin.credential.cert(sa),
  });
}

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function absoluteUrl(req, path) {
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}${path}`;
}

// Preços
const PLAN_PRICES = {
  plus: 5.99,
  pro: 8.99,
  business: 61.99,
};

function normalizePlan(input) {
  let p = String(input || "").toLowerCase().trim();

  p = p
    .replace(/^plano[_-]?/g, "")
    .replace(/^vip[_-]?/g, "")
    .replace(/^plan[_-]?/g, "")
    .replace(/\s+/g, "");

  p = p
    .replace(/[_-]?mensal$/g, "")
    .replace(/[_-]?monthly$/g, "")
    .replace(/[_-]?anual$/g, "")
    .replace(/[_-]?yearly$/g, "")
    .replace(/[_-]?ano$/g, "");

  const map = {
    "+": "plus",
    plus: "plus",
    basic: "plus",
    free: "plus",

    pro: "pro",
    premium: "pro",

    business: "business",
    empresa: "business",
    anual: "business",
    yearly: "business",
    year: "business",
    ano: "business",
  };

  return map[p] || p;
}

function makeIdempotencyKey() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `idem_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function toLabel(mpStatus) {
  const s = String(mpStatus || "").toLowerCase();
  if (s === "approved") return "aprovado";
  if (s === "pending" || s === "in_process") return "pendente";
  if (s === "rejected") return "recusado";
  if (s === "cancelled" || s === "expired" || s === "refunded" || s === "charged_back") return "expirado";
  return "pendente";
}

async function requireUser(req) {
  const auth = (req.headers.authorization || req.headers.Authorization || "").toString();
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    const e = new Error("Token ausente.");
    e.status = 401;
    throw e;
  }
  const token = m[1].trim();
  if (!token) {
    const e = new Error("Token ausente.");
    e.status = 401;
    throw e;
  }

  ensureAdmin();
  const decoded = await admin.auth().verifyIdToken(token);
  const uid = String(decoded.uid || "");
  const email = String(decoded.email || "");
  if (!uid || !email) {
    const e = new Error("Token inválido (uid/email ausente).");
    e.status = 401;
    throw e;
  }
  return { uid, email };
}

module.exports = async (req, res) => {
  cors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "Método não permitido" });
  }

  try {
    const mpToken = getEnv("MP_ACCESS_TOKEN");
    if (!mpToken) return json(res, 500, { ok: false, error: "MP_ACCESS_TOKEN ausente (ENV)." });

    // Autentica usuário (obrigatório)
    const { uid, email } = await requireUser(req);

    // Body pode chegar como string
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const planoRaw = body.plano;
    const plano = normalizePlan(planoRaw);

    // guildId: por padrão, use o próprio UID (mais seguro)
    const guildId = String(body.guildId || uid);

    if (!plano || !PLAN_PRICES[plano]) {
      return json(res, 400, { ok: false, error: `Plano inválido: ${planoRaw}` });
    }
    if (!email.includes("@")) {
      return json(res, 400, { ok: false, error: "Email inválido para pagamento." });
    }
    // Evita alguém tentar criar pagamento para outra guilda via body
    if (guildId !== uid) {
      return json(res, 403, { ok: false, error: "Guild inválida para este usuário." });
    }

    ensureAdmin();
    const db = admin.firestore();

    const solicitaRef = db.collection("solicita").doc(uid);
    const snap = await solicitaRef.get();

    // Se já existe pendente, reutiliza o mesmo PIX
    if (snap.exists) {
      const d = snap.data() || {};
      const labelOld = String(d.status || "").toLowerCase();
      const planoOld = String(d.plano || "");
      const paymentIdOld = String(d.paymentId || "");

      if (labelOld === "pendente" && paymentIdOld) {
        if (planoOld && planoOld !== plano) {
          return json(res, 409, {
            ok: false,
            error: "Você já tem uma solicitação pendente. Finalize ou aguarde expirar para trocar de plano.",
            pending: { paymentId: paymentIdOld, status: d.mpStatus || "pending", label: "pendente", plano: planoOld },
          });
        }

        return json(res, 200, {
          ok: true,
          reused: true,
          paymentId: paymentIdOld,
          status: d.mpStatus || "pending",
          label: "pendente",
          qrCode: d.qrCode || "",
          qrBase64: d.qrBase64 || "",
          amount: Number(d.amount || PLAN_PRICES[plano]),
          plano: planoOld || plano,
        });
      }
    }

    const amount = Number(PLAN_PRICES[plano]);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json(res, 400, { ok: false, error: "Valor inválido." });
    }

    const notification_url = absoluteUrl(req, "/api/mp_webhook");

    const payload = {
      transaction_amount: amount,
      description: `Guilda HUB - ${plano.toUpperCase()}`,
      payment_method_id: "pix",
      payer: { email },
      notification_url,
      external_reference: `guilda:${guildId}|uid:${uid}|plano:${plano}`,
    };

    const idemKey = makeIdempotencyKey();

    const r = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mpToken}`,
        "X-Idempotency-Key": idemKey,
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      console.error("[MP_CREATE_PIX] Mercado Pago recusou", {
        mp_status: r.status,
        mp_response: data,
        idemKey,
      });

      return json(res, 400, {
        ok: false,
        error: "Mercado Pago recusou a criação do pagamento.",
        mp_status: r.status,
        mp_response: data,
      });
    }

    const paymentId = String(data.id || "");
    const mpStatus = String(data.status || "pending");
    const label = toLabel(mpStatus);

    const tx = data.point_of_interaction?.transaction_data || {};
    const qrCode = tx.qr_code || "";
    const qrBase64 = tx.qr_code_base64 || "";

    await solicitaRef.set(
      {
        tipo: "mercadopago_pix",
        paymentId,
        mpStatus,
        status: label, // aprovado/pendente/recusado/expirado
        nomePagador: `pagamento > ${label}`,
        plano,
        uid,
        email,
        guildId,
        amount,
        qrCode,
        qrBase64,
        notification_url,
        idempotencyKey: idemKey,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAtMs: Date.now(),
      },
      { merge: true }
    );

    return json(res, 200, {
      ok: true,
      paymentId,
      status: mpStatus,
      label,
      qrCode,
      qrBase64,
      amount,
      plano,
    });
  } catch (err) {
    const status = err && err.status ? Number(err.status) : 500;
    return json(res, status, { ok: false, error: String(err && err.message ? err.message : err) });
  }
};
