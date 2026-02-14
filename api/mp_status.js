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

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const mpToken = process.env.MP_ACCESS_TOKEN;
    if (!mpToken) return res.status(500).json({ error: 'MP_ACCESS_TOKEN não configurado.' });

    const paymentId = (req.query?.paymentId || '').toString().trim();
    if (!paymentId) return res.status(400).json({ error: 'paymentId ausente.' });

    initAdmin();

    const mpResp = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${mpToken}` }
    });
    const mpData = await mpResp.json().catch(() => ({}));
    if (!mpResp.ok) return res.status(400).json({ error: mpData?.message || 'Erro ao consultar pagamento.' });

    const status = mpData.status || 'pending';
    const label = toLabel(status);

    // Atualiza solicita (redundância útil em teste mesmo sem webhook)
    const docId = `mp_${paymentId}`;
    await admin.firestore().doc(`solicita/${docId}`).set({
      mpStatus: status,
      status: label,
      nomePagador: `pagamento > ${label}`,
      updatedAtMs: Date.now(),
    }, { merge: true });

    return res.status(200).json({ paymentId, status, label });

  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erro interno.' });
  }
};