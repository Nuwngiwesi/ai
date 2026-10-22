'use strict';
/*
 * LYNKO AI — backend (Node.js 18+ and Express)
 * Creator: Nethum Akash
 *
 * Environment variables:
 *   GEMINI_API_KEY    (required) Google AI Studio key
 *   GEMINI_MODEL      (optional) default: gemini-2.5-flash
 *   BRAVE_API_KEY     (optional) use Brave for POST /api/search; otherwise Gemini Google Search is used
 *   SYSTEM_PROMPT     (optional) replaces the built-in LYNKO AI personality
 *   CORS_ORIGIN       (optional) one extra allowed origin; same-origin works by default
 *   RATE_LIMIT_PER_MIN, GEMINI_TIMEOUT_MS, PORT (optional)
 */
const express = require('express');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 25000;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN) || 30;

const MAX_MESSAGES = 20;
const MAX_MSG_CHARS = 4000;
const MAX_PROMPT_CHARS = 1000;
const MAX_QUERY_CHARS = 200;

const DEFAULT_PROMPT = process.env.SYSTEM_PROMPT || [
  'You are LYNKO AI, a funny, friendly and clever voice assistant created by Nethum Akash.',
  'You speak Sinhala, Singlish (Sinhala written in English letters) and English.',
  'Reply in the same language and style the user writes in. If they write Singlish, reply in natural, casual Singlish.',
  'Your replies are often read aloud, so keep them short and conversational unless the user asks for detail. Avoid heavy markdown; use code fences only for code.',
  'Help with coding, school work, technology and everyday questions. A light joke is welcome, but accuracy comes first.',
  'You run in a web browser. You cannot control the phone flashlight, volume, Wi-Fi, Bluetooth or other apps. If asked, say so honestly.',
  'If you do not know something, say so instead of guessing.'
].join('\n');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// ---------- security headers and CORS ----------
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  });
  const origin = req.headers.origin;
  if (CORS_ORIGIN && origin && origin === CORS_ORIGIN) {
    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin'
    });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

// ---------- minimal request log (no bodies, no keys) ----------
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api/')) {
      console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
    }
  });
  next();
});

app.use(express.json({ limit: '32kb' }));

// ---------- rate limiting (in-memory, per IP) ----------
const hits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of hits) if (h.reset <= now) hits.delete(ip);
}, 60000).unref();

app.use('/api', (req, res, next) => {
  const now = Date.now();
  const ip = req.ip || 'unknown';
  let h = hits.get(ip);
  if (!h || h.reset <= now) {
    h = { count: 0, reset: now + 60000 };
    hits.set(ip, h);
  }
  h.count++;
  if (h.count > RATE_LIMIT) {
    res.set('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
    return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.', code: 'rate_limited' });
  }
  next();
});

// ---------- helpers ----------
async function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(/\u0000/g, '').trim().slice(0, max) : '';
}

// ---------- routes ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    ai: { configured: Boolean(GEMINI_API_KEY), provider: 'gemini', model: GEMINI_MODEL },
    search: { configured: Boolean(BRAVE_API_KEY || GEMINI_API_KEY), provider: BRAVE_API_KEY ? 'brave' : (GEMINI_API_KEY ? 'gemini-google-search' : null) },
    uptimeSeconds: Math.round(process.uptime())
  });
});

app.post('/api/chat', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(503).json({
      error: 'AI is not configured on the server. Set the GEMINI_API_KEY environment variable and restart.',
      code: 'missing_key'
    });
  }
  const body = req.body;
  if (!body || !Array.isArray(body.messages)) {
    return res.status(400).json({ error: 'Request body must be JSON with a "messages" array.', code: 'bad_request' });
  }

  // Normalise history: bounded, alternating roles, starting and ending with the user.
  const contents = [];
  for (const m of body.messages.slice(-MAX_MESSAGES)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const text = cleanText(m.content, MAX_MSG_CHARS);
    if (!text) continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += '\n' + text;
    else contents.push({ role, parts: [{ text }] });
  }
  while (contents.length && contents[0].role !== 'user') contents.shift();
  if (!contents.length || contents[contents.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'The last message must be from the user and not empty.', code: 'bad_request' });
  }

  const extra = cleanText(body.systemPrompt, MAX_PROMPT_CHARS);
  const systemText = extra ? `${DEFAULT_PROMPT}\n\nExtra instructions from the user:\n${extra}` : DEFAULT_PROMPT;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  try {
    const r = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemText }] },
        contents,
        generationConfig: { temperature: 0.8, maxOutputTokens: 1024 }
      })
    }, GEMINI_TIMEOUT_MS);

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const detail = cleanText(data && data.error && data.error.message, 200);
      if (r.status === 429) {
        return res.status(429).json({ error: 'Gemini API limit reached. Wait a minute or check your quota.', code: 'quota' });
      }
      if (r.status === 400 || r.status === 401 || r.status === 403) {
        return res.status(502).json({ error: `Gemini rejected the request (${r.status}). Check GEMINI_API_KEY and GEMINI_MODEL. ${detail}`.trim(), code: 'upstream_auth' });
      }
      return res.status(502).json({ error: `Gemini returned an error (${r.status}). ${detail}`.trim(), code: 'upstream_error' });
    }

    const cand = data.candidates && data.candidates[0];
    const reply = cand && cand.content && Array.isArray(cand.content.parts)
      ? cand.content.parts.map(p => (typeof p.text === 'string' ? p.text : '')).join('').trim()
      : '';
    if (!reply) {
      const blocked = data.promptFeedback && data.promptFeedback.blockReason;
      return res.status(422).json({
        error: blocked ? `Gemini blocked this prompt (${blocked}). Try rephrasing.` : 'Gemini returned an empty reply. Try again.',
        code: 'empty_reply'
      });
    }
    res.json({ reply, model: GEMINI_MODEL });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return res.status(504).json({ error: 'Gemini took too long to respond. Please try again.', code: 'timeout' });
    }
    console.error('chat error:', err && err.message);
    res.status(502).json({ error: 'Could not reach the Gemini API. Check the server network connection.', code: 'network' });
  }
});

app.post('/api/search', async (req, res) => {
  if (!BRAVE_API_KEY && !GEMINI_API_KEY) {
    return res.status(501).json({
      error: 'Web search is not configured. Set GEMINI_API_KEY (Google Search grounding) or BRAVE_API_KEY on the server. Google search commands still open in your browser.',
      code: 'search_not_configured'
    });
  }
  const query = cleanText(req.body && req.body.query, MAX_QUERY_CHARS);
  if (!query) return res.status(400).json({ error: 'Provide a non-empty "query" string.', code: 'bad_request' });

  // Option 1: Brave Search API (if a key is set)
  if (BRAVE_API_KEY) {
    try {
      const r = await fetchWithTimeout(
        'https://api.search.brave.com/res/v1/web/search?count=5&q=' + encodeURIComponent(query),
        { headers: { Accept: 'application/json', 'X-Subscription-Token': BRAVE_API_KEY } },
        10000
      );
      if (!r.ok) {
        return res.status(r.status === 429 ? 429 : 502).json({
          error: r.status === 429 ? 'Search API limit reached.' : `Search provider error (${r.status}).`,
          code: 'search_error'
        });
      }
      const data = await r.json();
      const results = ((data.web && data.web.results) || []).slice(0, 5).map(x => ({
        title: cleanText(x.title, 200),
        url: cleanText(x.url, 500),
        description: cleanText(String(x.description || '').replace(/<[^>]*>/g, ''), 300)
      }));
      return res.json({ query, provider: 'brave', results });
    } catch (err) {
      if (err && err.name === 'AbortError') return res.status(504).json({ error: 'Search timed out.', code: 'timeout' });
      return res.status(502).json({ error: 'Could not reach the search provider.', code: 'network' });
    }
  }

  // Option 2: Gemini with Google Search grounding (no extra key needed)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  try {
    const r = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'Answer using current web results. Be short and factual. Reply in the same language style as the question (Sinhala, Singlish or English).' }] },
        contents: [{ role: 'user', parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 800 }
      })
    }, 30000);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const detail = cleanText(data && data.error && data.error.message, 200);
      return res.status(r.status === 429 ? 429 : 502).json({
        error: r.status === 429 ? 'Gemini API limit reached. Try again later.' : `Gemini search failed (${r.status}). ${detail}`.trim(),
        code: 'search_error'
      });
    }
    const cand = data.candidates && data.candidates[0];
    const answer = cand && cand.content && Array.isArray(cand.content.parts)
      ? cand.content.parts.map(p => (typeof p.text === 'string' ? p.text : '')).join('').trim() : '';
    const chunks = (cand && cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
    const seen = new Set();
    const results = [];
    for (const c of chunks) {
      const w = c && c.web;
      if (!w || !w.uri || seen.has(w.uri)) continue;
      seen.add(w.uri);
      results.push({ title: cleanText(w.title, 200), url: cleanText(w.uri, 800), description: '' });
      if (results.length >= 5) break;
    }
    if (!answer) return res.status(422).json({ error: 'Search returned no answer. Try rephrasing.', code: 'empty_reply' });
    res.json({ query, provider: 'gemini-google-search', answer, results });
  } catch (err) {
    if (err && err.name === 'AbortError') return res.status(504).json({ error: 'Search timed out.', code: 'timeout' });
    console.error('search error:', err && err.message);
    res.status(502).json({ error: 'Could not reach the Gemini API for search.', code: 'network' });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route.', code: 'not_found' }));

// ---------- error handling ----------
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON in request body.', code: 'bad_json' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.', code: 'too_large' });
  console.error('server error:', err && err.message);
  res.status(500).json({ error: 'Unexpected server error.', code: 'server_error' });
});

app.listen(PORT, HOST, () => {
  console.log(`LYNKO AI listening on http://${HOST}:${PORT}`);
  console.log(`Gemini: ${GEMINI_API_KEY ? 'configured (' + GEMINI_MODEL + ')' : 'NOT configured, set GEMINI_API_KEY'}`);
  console.log(`Search: ${BRAVE_API_KEY ? 'brave' : (GEMINI_API_KEY ? 'gemini google search' : 'not configured')}`);
});
