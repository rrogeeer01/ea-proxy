module.exports = async (req, res) => {
  const { path, ...params } = req.query;
  const allowed = new Set(['clubs/info', 'clubs/matches', 'allTimeLeaderboard/search']);
  if (!allowed.has(path)) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  const url = new URL('https://proclubs.ea.com/api/fc/' + path);
  url.search = new URLSearchParams(params);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        Referer: 'https://www.ea.com/',
        Origin: 'https://www.ea.com',
      },
    });
    const text = await response.text();
    res.status(response.status).setHeader('Content-Type', 'application/json').send(text);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
};
