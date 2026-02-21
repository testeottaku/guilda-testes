// api/mp_create_pix.js
// Vercel Serverless Function (CommonJS) — Node 24+ (fetch nativo)

const admin = require("firebase-admin");

function parseExternalReference(refStr) {
  const out = { guildId: null, uid: null, plano: null };
  const s = String(refStr || "").trim();
  if (!s) return out;

  // formato esperado: guilda:<gid>|uid:<uid>|plano:<plano>
  const parts = s.split("|");
  for (const p of parts) {
    const [kRaw, ...rest] = p.split(":");
    const k = String(kRaw || "").trim().toLowerCase();
    const v = rest.join(":").trim();
    if (!v) continue;
    if (k === "guilda" || k === "guildid" || k === "guild") out.guildId = v;
    if (k === "uid" || k === "user" || k === "userid") out.uid = v;
    if (k === "plano" || k === "plan" || k === "tier") out.plano = v;
  }
  return out;
}

function toLabel(mpStatus) {
  const s = String(mpStatus || "").toLowerCase();
  if (s === "approved") return "aprovado";
  if (s === "pending" || s === "in_process") return "pendente";
  if (s === "rejected") return "recusado";
  if (s === "cancelled" || s === "expired" || s === "refunded" || s === "charged_back") return "expirado";
  return "pendente";
}

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

// Ajuste de preços (troque se quiser)
const PLAN_PRICES = {
  plus: 5.99,
  pro: 8.99,
  business: 61.99,
};

// Normaliza e mapeia variações que o front pode enviar
function normalizePlan(input) {
  let p = String(input || "").toLowerCase().trim();

  // remove prefixos comuns
  p = p
    .replace(/^plano[_-]?/g, "")
    .replace(/^vip[_-]?/g, "")
    .replace(/^plan[_-]?/g, "")
    .replace(/\s+/g, "");

  // remove sufixos comuns
  p = p
    .replace(/[_-]?mensal$/g, "")
    .replace(/[_-]?monthly$/g, "")
    .replace(/[_-]?anual$/g, "")
    .replace(/[_-]?yearly$/g, "")
    .replace(/[_-]?ano$/g, "");

  // aliases
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
  // Node 24 tem crypto.randomUUID em globalThis.crypto
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `idem_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/**
 * Rate limit leve por UID (anti-flood HTTP sem prejudicar usuário real)
 * Ex.: 8 requisições por minuto por UID.
 */
async function uidRateLimit(db, uid, opts = {}) {
  const WINDOW_MS = Number(opts.windowMs || 60_000);
  const MAX_REQ = Number(opts.maxRequests || 8);

  const ref = db.collection("rate_http_pix").doc(uid);
  const snap = await ref.get();
  const now = Date.now();

  let windowStart = now;
  let count = 1;

  if (snap.exists) {
    const d = snap.data() || {};
    windowStart = Number(d.windowStart || now);
    count = Number(d.count || 0);

    if (now - windowStart < WINDOW_MS) {
      if (count >= MAX_REQ) return { ok: false, retryAfterMs: WINDOW_MS - (now - windowStart) };
      count += 1;
    } else {
      windowStart = now;
      count = 1;
    }
  }

  await ref.set({ windowStart, count, updatedAtMs: now }, { merge: true });
  return { ok: true };
}

/**
 * Rate limit só para CRIAR NOVO PIX (cooldown longo, ex.: 30 min / 1h)
 * Aplicar somente quando NÃO existe pendente para reutilizar.
 */
async function creationCooldown(db, uid, cooldownMs) {
  const now = Date.now();
  const ref = db.collection("rate_new_pix").doc(uid);
  const snap = await ref.get();

  if (snap.exists) {
    const d = snap.data() || {};
    const lastCreatedAt = Number(d.lastCreatedAt || 0);
    if (lastCreatedAt && now - lastCreatedAt < cooldownMs) {
      return { ok: false, retryAfterMs: cooldownMs - (now - lastCreatedAt) };
    }
  }
  return { ok: true };
}

async function markCreated(db, uid) {
  const now = Date.now();
  const ref = db.collection("rate_new_pix").doc(uid);
  await ref.set({ lastCreatedAt: now, updatedAtMs: now }, { merge: true });
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

    ensureAdmin();
    const db = admin.firestore();

    // Body pode chegar como string
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

    // Segurança: se vier Firebase ID Token, usamos ele como fonte da verdade
    const authz = String(req.headers?.authorization || "").trim();
    let tokenUid = "";
    let tokenEmail = "";
    if (authz.toLowerCase().startsWith("bearer ")) {
      const idToken = authz.slice(7).trim();
      try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        tokenUid = String(decoded?.uid || "");
        tokenEmail = String(decoded?.email || "");
      } catch (_) {
        return json(res, 401, { ok: false, error: "Token inválido. Faça login novamente." });
      }
    }

    const planoRaw = body.plano;
    const plano = normalizePlan(planoRaw);

    const uid = tokenUid || String(body.uid || "");
    const email = tokenEmail || String(body.email || "");
    const guildId = String(body.guildId || "");

    if (!plano || !PLAN_PRICES[plano]) {
      return json(res, 400, { ok: false, error: `Plano inválido: ${planoRaw}` });
    }
    if (!uid || !email || !guildId) {
      return json(res, 400, { ok: false, error: "Dados ausentes (uid/email/guildId)." });
    }
    if (!email.includes("@")) {
      return json(res, 400, { ok: false, error: "Email inválido para pagamento." });
    }

    // ✅ Anti-flood HTTP leve (sem atrapalhar usuário normal)
    const rl = await uidRateLimit(db, uid, { windowMs: 60_000, maxRequests: 8 });
    if (!rl.ok) {
      const waitSec = Math.max(1, Math.ceil((rl.retryAfterMs || 0) / 1000));
      res.setHeader("Retry-After", String(waitSec));
      return json(res, 429, { ok: false, error: "Muitas tentativas. Aguarde um pouco e tente novamente." });
    }

    const amount = Number(PLAN_PRICES[plano]);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json(res, 400, { ok: false, error: "Valor inválido." });
    }

    // 1 solicitação por UID (documento fixo)
    // Se já existir uma solicitação pendente, reutiliza.
    const sRef = db.collection("solicita").doc(uid);
    const sSnap = await sRef.get();
    if (sSnap.exists) {
      const s = sSnap.data() || {};
      const mpStatusOld = String(s.mpStatus || s.status || "");
      const labelOld = toLabel(mpStatusOld);
      const planOld = normalizePlan(s.plano);
      const paymentIdOld = String(s.paymentId || "");

      if (labelOld === "pendente" && paymentIdOld) {
        if (planOld && planOld !== plano) {
          return json(res, 409, {
            ok: false,
            error: "Você já tem uma solicitação pendente. Finalize ou aguarde antes de pedir outro plano.",
            pending: {
              plano: planOld,
              paymentId: paymentIdOld,
              status: s.mpStatus || s.status || "pending",
            },
          });
        }

        // Mesmo plano: retorna o mesmo PIX já criado
        return json(res, 200, {
          ok: true,
          reused: true,
          paymentId: paymentIdOld,
          status: s.mpStatus || s.status || "pending",
          qrCode: s.qrCode || "",
          qrBase64: s.qrBase64 || "",
          amount: Number(s.amount || amount),
          plano: planOld || plano,
        });
      }
    }

    // ✅ Cooldown longo: só quando for CRIAR um NOVO PIX (não afeta reutilização)
    const COOLDOWN_MS = 30 * 60 * 1000; // 30 min (troque para 60*60*1000 = 1h se quiser)
    const cd = await creationCooldown(db, uid, COOLDOWN_MS);
    if (!cd.ok) {
      const waitMin = Math.max(1, Math.ceil((cd.retryAfterMs || 0) / 60000));
      return json(res, 429, {
        ok: false,
        error: `Você já criou um pagamento recentemente. Aguarde ${waitMin} min e tente novamente.`,
      });
    }

    // Webhook URL (no seu domínio)
    const notification_url = absoluteUrl(req, "/api/mp_webhook");

    // Cria pagamento PIX (Mercado Pago)
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
    const status = String(data.status || "pending");
    const label = toLabel(status);

    const tx = data.point_of_interaction?.transaction_data || {};
    const qrCode = tx.qr_code || "";
    const qrBase64 = tx.qr_code_base64 || "";

    // Salva “solicita” automaticamente (doc fixo por UID)
    await sRef.set(
      {
        tipo: "mercadopago_pix",
        paymentId,
        mpStatus: status,
        status: label,
        nomePagador: `pagamento > ${label}`,
        plano,
        uid,
        email,
        guildId,
        amount,
        notification_url,
        idempotencyKey: idemKey,
        qrCode,
        qrBase64,
        updatedAtMs: Date.now(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // Marca cooldown apenas quando criou com sucesso
    await markCreated(db, uid);

    return json(res, 200, {
      ok: true,
      paymentId,
      status,
      qrCode,
      qrBase64,
      amount,
      plano,
    });
  } catch (err) {
    return json(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
  }
};
