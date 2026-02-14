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

    // tenta obter contexto pelo external_reference (se tiver)
    let uid = null, guildId = null, plan = null;
    try {
      const ref = mpData.external_reference ? JSON.parse(mpData.external_reference) : null;
      uid = ref?.uid ? String(ref.uid) : null;
      guildId = ref?.guildId ? String(ref.guildId) : null;
      plan = ref?.plan ? String(ref.plan) : null;
    } catch (_) {}

    // Se não veio, tenta recuperar do doc solicita
    const docId = `mp_${paymentId}`;
    const sRef = admin.firestore().doc(`solicita/${docId}`);
    const sSnap = await sRef.get();
    if (sSnap.exists) {
      const s = sSnap.data() || {};
      uid = uid || (s.uid ? String(s.uid) : null);
      guildId = guildId || (s.guildId ? String(s.guildId) : null);
      plan = plan || (s.plano ? String(s.plano) : null);
    }

    await sRef.set({
      paymentId: String(paymentId),
      mpStatus,
      status: label,
      nomePagador: `pagamento > ${label}`,
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
