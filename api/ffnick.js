/**
 * Vercel Serverless Function
 * GET /api/ffnick?uid=123456789
 *
 * Faz a chamada server-side para api.mitsuri.fun (região BR) e retorna somente o nick.
 */
export default async function handler(req, res) {
  try {
    const uidRaw = (req.query?.uid ?? "").toString().trim();
    const uid = uidRaw.replace(/[^\d]/g, "");
    if (!uid) {
      return res.status(400).json({ error: "uid inválido" });
    }

    // Mantém a chave aqui no backend para não depender do navegador (e evitar CORS).
    const KEY = "mitsuri_UVPRYNm5RNdvirmjrMQqlu8XVpEpFPxP";
    const ENDPOINT = "https://api.mitsuri.fun/api/trpc/api.info";

    const body = { json: { key: KEY, uid: Number(uid), region: "BR" } };

    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        // "User-Agent" ajuda em alguns bloqueios básicos (não é “burlar”, é só identificar o client).
        "User-Agent": "GuildaHub/1.0 (+vercel)"
      },
      body: JSON.stringify(body)
    });

    const data = await r.json().catch(() => null);
    if (!r.ok || !data) {
      return res.status(502).json({ error: "Falha ao consultar API externa." });
    }

    // A Mitsuri às vezes vem em result.data.json, e pode ter variações.
    const payload =
      data?.result?.data?.json ??
      data?.result?.data?.json?.data ??
      data?.data?.json ??
      data?.json ??
      data;

    const acc = payload?.AccountInfo || payload?.captainBasicInfo || payload?.account || payload;
    const nick =
      acc?.AccountName ||
      acc?.accountName ||
      acc?.nickname ||
      acc?.nick ||
      payload?.nickname ||
      payload?.nick;

    if (!nick || typeof nick !== "string") {
      return res.status(404).json({ error: "Nick não encontrado." });
    }

    return res.status(200).json({ nick: nick.trim() });
  } catch (e) {
    return res.status(500).json({ error: "Erro interno." });
  }
}