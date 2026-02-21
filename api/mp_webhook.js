const admin = require('firebase-admin');

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT');
  return JSON.parse(raw);
}

function initAdmin() {
  if (admin.apps.length) return;
  admin.initializeApp({ credential: admin.credential.cert(getServiceAccount()) });
}

function toLabel(mpStatus){
  const s = String(mpStatus || '').toLowerCase();
  if (s === 'approved') return 'aprovado';
  if (s === 'pending' || s === 'in_process') return 'pendente';
  if (s === 'rejected') return 'recusado';
  if (s === 'cancelled' || s === 'expired' || s === 'refunded' || s === 'charged_back') return 'expirado';
  return 'pendente';
}

function parseExternalReference(refStr) {
  const out = { guildId: null, uid: null, plan: null };
  const s = String(refStr || '').trim();
  if (!s) return out;

  // formato esperado: guilda:<gid>|uid:<uid>|plano:<plano>
  const parts = s.split('|');
  for (const p of parts) {
    const [kRaw, ...rest] = p.split(':');
    const k = String(kRaw || '').trim().toLowerCase();
    const v = rest.join(':').trim();
    if (!v) continue;
    if (k === 'guilda' || k === 'guildid' || k === 'guild') out.guildId = v;
    if (k === 'uid' || k === 'user' || k === 'userid') out.uid = v;
    if (k === 'plano' || k === 'plan' || k === 'tier') out.plan = v;
  }
  return out;
}

function daysForPlan(plan){
  const p = String(plan || '').toLowerCase();

  if (p === 'business') return 365;
  if (p === 'pro') return 30;
  if (p === 'plus') return 30;

  return 30;
}

module.exports = async (req, res) => {
  // Mercado Pago pode re-tentar; responder 200 rápido sempre que possível
  try {
    if (req.method !== 'POST') return res.status(405).send('Method not allowed');

    const mpToken = process.env.MP_ACCESS_TOKEN;
    if (!mpToken) return res.status(500).send('MP_ACCESS_TOKEN missing');

    initAdmin();

    // Extrai paymentId de vários formatos comuns
    const body = req.body || {};
    const query = req.query || {};

    let paymentId =
      (body?.data?.id ?? body?.id ?? query?.id ?? query?.data_id ?? '').toString().trim();

    // Alguns webhooks chegam como topic=payment&id=123
    if (!paymentId && query?.topic && query?.id) paymentId = String(query.id);

    if (!paymentId) return res.status(200).send('ok');

    // Busca status real no MP
    const mpResp = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${mpToken}` }
    });
    const mpData = await mpResp.json().catch(() => ({}));
    if (!mpResp.ok) return res.status(200).send('ok');

    const mpStatus = mpData.status || 'pending';
    const label = toLabel(mpStatus);

    // Contexto vem do MP (fonte da verdade)
    const ref = parseExternalReference(mpData.external_reference);
    const uid = ref.uid ? String(ref.uid) : null;
    const guildId = ref.guildId ? String(ref.guildId) : null;
    const plan = ref.plan ? String(ref.plan) : null;

    // Atualiza solicita por UID (novo padrão). Se não tiver UID no external_reference, cai no padrão antigo.
    const sRef = uid
      ? admin.firestore().doc(`solicita/${uid}`)
      : admin.firestore().doc(`solicita/mp_${paymentId}`);

    await sRef.set({
      paymentId: String(paymentId),
      mpStatus,
      status: label,
      nomePagador: `pagamento > ${label}`,
      plano: plan || undefined,
      guildId: guildId || undefined,
      uid: uid || undefined,
      updatedAtMs: Date.now(),
    }, { merge: true });

    // Se aprovado, aplica VIP
    if (label === 'aprovado' && plan) {
      const days = daysForPlan(plan);
      const expiresAtMs = Date.now() + (days * 24 * 60 * 60 * 1000);

      if (guildId) {
        await admin.firestore().doc(`configGuilda/${guildId}`).set({
          vipTier: plan,
          vipExpiresAt: expiresAtMs,
          updatedAtMs: Date.now(),
        }, { merge: true });

        // fallback: alguns lugares usam /guildas
        await admin.firestore().doc(`guildas/${guildId}`).set({
          vipTier: plan,
          vipExpiresAt: expiresAtMs,
          updatedAtMs: Date.now(),
        }, { merge: true });
      }

      if (uid) {
        await admin.firestore().doc(`users/${uid}`).set({
          vipTier: plan,
          vipExpiresAt: expiresAtMs,
          updatedAtMs: Date.now(),
        }, { merge: true });
      }
    }

    return res.status(200).send('ok');
  } catch (_) {
    return res.status(200).send('ok');
  }
};
