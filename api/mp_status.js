// api/mp_status.js
// Segurança:
// - Exige Firebase ID Token (Authorization: Bearer ...)
// - Só permite consultar/atualizar status se:
//   a) o paymentId for do próprio UID (via external_reference), ou
//   b) o usuário for CEO (email está em /chefe/security.ceo)

const admin = require("firebase-admin");

function getEnv(name) {
  const v = process.env[name];
  return (v && String(v).trim()) || "";
}

function ensureAdmin() {
  if (admin.apps.length) return;

  const saRaw = getEnv("FIREBASE_SERVICE_ACCOUNT");
  if (!saRaw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT");

  const sa = JSON.parse(saRaw);
  if (sa.private_key && typeof sa.private_key === "string") {
    sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  }
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}

function toLabel(mpStatus) {
  const s = String(mpStatus || "").toLowerCase();
  if (s === "approved") return "aprovado";
  if (s === "pending" || s === "in_process") return "pendente";
  if (s === "rejected") return "recusado";
  if (s === "cancelled" || s === "expired" || s === "refunded" || s === "charged_back") return "expirado";
  return "pendente";
}

function parseExternalRef(ext) {
  // formato: guilda:<gid>|uid:<uid>|plano:<plano>
  const s = String(ext || "");
  const out = { guildId: "", uid: "", plano: "" };
  for (const part of s.split("|")) {
    const [k, ...rest] = part.split(":");
    const v = rest.join(":");
    if (!k) continue;
    const key = k.trim().toLowerCase();
    const val = (v || "").trim();
    if (key === "guilda") out.guildId = val;
    if (key === "uid") out.uid = val;
    if (key === "plano") out.plano = val;
  }
  return out;
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

async function isCeoEmail(email) {
  const db = admin.firestore();
  const snap = await db.doc("chefe/security").get();
  const ceo = (snap.exists && snap.data() && snap.data().ceo) || [];
  return Array.isArray(ceo) && ceo.includes(email);
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    const mpToken = getEnv("MP_ACCESS_TOKEN");
    if (!mpToken) return res.status(500).json({ error: "MP_ACCESS_TOKEN não configurado." });

    // Autenticação obrigatória
    const { uid: callerUid, email: callerEmail } = await requireUser(req);

    const paymentId = (req.query?.paymentId || "").toString().trim();
    if (!paymentId) return res.status(400).json({ error: "paymentId ausente." });

    // Consulta MP
    const mpResp = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${mpToken}` },
    });
    const mpData = await mpResp.json().catch(() => ({}));
    if (!mpResp.ok) return res.status(400).json({ error: mpData?.message || "Erro ao consultar pagamento." });

    const status = mpData.status || "pending";
    const label = toLabel(status);

    const ext = mpData.external_reference || "";
    const parsed = parseExternalRef(ext);
    const ownerUid = parsed.uid;

    if (!ownerUid) return res.status(400).json({ error: "Pagamento sem UID no external_reference." });

    // Permissão: dono do pagamento OU CEO
    if (callerUid !== ownerUid) {
      ensureAdmin();
      const ceo = await isCeoEmail(callerEmail);
      if (!ceo) return res.status(403).json({ error: "Sem permissão para consultar este pagamento." });
    }

    // Atualiza doc por UID
    ensureAdmin();
    await admin.firestore().doc(`solicita/${ownerUid}`).set(
      {
        mpStatus: status,
        status: label,
        nomePagador: `pagamento > ${label}`,
        updatedAtMs: Date.now(),
      },
      { merge: true }
    );

    return res.status(200).json({ paymentId, status, label, uid: ownerUid });
  } catch (e) {
    const code = e?.status ? Number(e.status) : 500;
    return res.status(code).json({ error: e?.message || "Erro interno." });
  }
};
