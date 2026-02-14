// api/mp_create_pix.js
// Vercel Serverless Function (CommonJS) — Node 24+ (fetch nativo)

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

// Ajuste de preços (troque se quiser)
const PLAN_PRICES = {
  plus: 5.99,
  pro: 8.99,
  business: 61.99,
};

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

    // Body pode chegar como string
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const plano = String(body.plano || "").toLowerCase();
    const uid = String(body.uid || "");
    const email = String(body.email || "");
    const guildId = String(body.guildId || "");

    if (!plano || !PLAN_PRICES[plano]) {
      return json(res, 400, { ok: false, error: "Plano inválido." });
    }
    if (!uid || !email || !guildId) {
      return json(res, 400, { ok: false, error: "Dados ausentes (uid/email/guildId)." });
    }

    const amount = Number(PLAN_PRICES[plano]);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json(res, 400, { ok: false, error: "Valor inválido." });
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

    const r = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mpToken}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      // Retorna o erro do MP para facilitar debug
      return json(res, 400, {
        ok: false,
        error: "Mercado Pago recusou a criação do pagamento.",
        mp_status: r.status,
        mp_response: data,
      });
    }

    const paymentId = String(data.id || "");
    const status = String(data.status || "pending");

    // QR / Copia e Cola
    const tx = data.point_of_interaction?.transaction_data || {};
    const qrCode = tx.qr_code || "";
    const qrBase64 = tx.qr_code_base64 || "";

    // Salva “solicita” automaticamente
    ensureAdmin();
    const db = admin.firestore();

    const docId = `mp_${paymentId}`;
    await db.collection("solicita").doc(docId).set(
      {
        tipo: "mercadopago_pix",
        paymentId,
        status,
        nomePagador: `pagamento > ${status}`,
        plano,
        uid,
        email,
        guildId,
        amount,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return json(res, 200, {
      ok: true,
      paymentId,
      status,
      qrCode,
      qrBase64,
      amount,
    });
  } catch (err) {
    return json(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
  }
};
