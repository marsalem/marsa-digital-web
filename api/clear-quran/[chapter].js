// api/clear-quran/[chapter].js
// Marsa Digital web — GET /api/clear-quran/:chapter: proxy for The Clear
// Quran (R) English translation (Dr. Mustafa Khattab), fronting Furqan
// Foundation's licensed API (https://api.theclearquran.org) so the shipped
// Quran Atlas app never embeds the real API key (mobile binaries are
// extractable).
//
// PURE PASSTHROUGH, NO CACHING — per Furqan Foundation's own terms (asked
// directly, answered 2026-11-16): bundling the text in the app is not
// allowed, and caching is only permitted client-side, scoped to the user's
// own session — never server-side. So this endpoint must re-fetch from
// Furqan on every call and must never store a response (Redis, disk,
// memory) for reuse across requests. The app's own translation cache
// (app/hooks/useTranslationCache.ts's transCache) already satisfies the
// client-side/session-scoped allowance on its own — it's plain React state,
// gone on app restart — so no caching logic needs to exist here at all.
//
// Furqan's API paginates at 30 verses/request; a chapter's full text may
// take several upstream calls (Al-Baqarah's 286 verses = 10 pages). Rate
// limiting is checked per UPSTREAM PAGE FETCHED (not once per incoming
// request) via a GLOBAL counter in lib/rateLimit.js, since Furqan's
// 60/min-1000/hour caps apply to our one shared API key across every Quran
// Atlas user combined, not per caller.

const { checkClearQuranUpstreamRateLimit, checkClearQuranClientRateLimit } = require('../../lib/rateLimit');

const API_BASE = process.env.CLEAR_QURAN_API_BASE || 'https://api.theclearquran.org';
const API_KEY = process.env.CLEAR_QURAN_API_KEY;
const PAGE_LIMIT = 30;
const CHAPTER_COUNT = 114;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const chapter = Number(req.query.chapter);
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > CHAPTER_COUNT) {
    res.status(400).json({ error: `chapter must be an integer between 1 and ${CHAPTER_COUNT}.` });
    return;
  }

  const { success: withinClientLimit } = await checkClearQuranClientRateLimit(req);
  if (!withinClientLimit) {
    res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    return;
  }

  if (!API_KEY) {
    console.error('CLEAR_QURAN_API_KEY is not configured.');
    res.status(500).json({ error: 'Clear Quran API is not configured.' });
    return;
  }

  try {
    const verses = {};
    let offset = 0;
    while (true) {
      const { success: withinUpstreamLimit } = await checkClearQuranUpstreamRateLimit();
      if (!withinUpstreamLimit) {
        res.status(503).json({ error: 'Clear Quran API is temporarily at capacity. Please try again shortly.' });
        return;
      }

      const upstream = await fetch(`${API_BASE}/chapters/${chapter}/verses?limit=${PAGE_LIMIT}&offset=${offset}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      if (!upstream.ok) throw new Error(`Furqan API responded ${upstream.status}`);
      const json = await upstream.json();
      if (!json.success) throw new Error('Furqan API responded success=false');

      for (const v of json.data) verses[String(v.verse_number)] = v.text_english;

      if (!json.meta.next_offset) break;
      offset = json.meta.next_offset;
    }

    // No cache-control/storage on our end — see file header. Downstream
    // (the app) is responsible for its own session-scoped reuse.
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ verses });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Clear Quran proxy failed:', message);
    // TEMPORARY: surfaced in the response body for live debugging while
    // wiring up the first deploy — revert to a generic client message
    // once this is confirmed working end to end.
    res.status(502).json({ error: 'Could not fetch translation text.', debug: message });
  }
};
