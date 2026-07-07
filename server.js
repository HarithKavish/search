const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static site
app.use(express.static(path.resolve(__dirname)));

// Simple image proxy using DuckDuckGo image endpoint.
// This helps avoid browser CORS issues and centralizes fetching logic.
app.get('/api/images', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });

  try {
    const ddg = new URL('https://duckduckgo.com/i.js');
    ddg.searchParams.set('q', q);

    const resp = await fetch(ddg.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SearchApp/1.0; +https://example.com)'
      }
    });

    if (!resp.ok) {
      return res.status(502).json({ error: `upstream ${resp.status}` });
    }

    const json = await resp.json();
    // The DuckDuckGo image endpoint returns { results: [...] }
    const results = Array.isArray(json.results) ? json.results.map((it) => ({
      src: it.image || it.url || it.src || '',
      thumbnail: it.thumbnail || it.tn || it.thumb || it.image || '',
      title: it.title || it.text || '',
      url: it.url || ''
    })) : [];

    res.json({ results });
  } catch (err) {
    console.error('proxy error', err && err.message);
    res.status(500).json({ error: String(err && err.message) });
  }
});

app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
