export default async function handler(req, res) {
  try {
    const { uid } = req.query;

    if (!uid) {
      return res.status(400).json({ error: "UID não informado" });
    }

    const response = await fetch(
      `https://api.mitsuri.fun/api/proxy?endpoint=ff_info&query=${uid}`,
      {
        method: "GET",
        headers: {
          "x-api-key": "dn_vffredz543",
          "Accept": "application/json"
        }
      }
    );

    if (!response.ok) {
      return res.status(500).json({ error: "Erro ao consultar API externa" });
    }

    const data = await response.json();

    const info = data.AccountInfo || {};
    const nickname = info.Name || null;

    if (!nickname) {
      return res.status(404).json({ error: "Jogador não encontrado" });
    }

    return res.status(200).json({
      nick: nickname,
      credit: "Informação fornecida por api.mitsuri.fun"
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Erro interno no servidor" });
  }
}
