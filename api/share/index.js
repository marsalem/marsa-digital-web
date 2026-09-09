// api/share/index.js
// Marsa Digital web — POST /api/share: create a new share.
//
// This file and api/share/[id].js are the ONLY two places any client
// (Quran Atlas's own app, import.html, anything else in the future)
// touches the Share Service — see lib/shareService.js's own header for
// why Redis access is isolated to that one module and never reaches
// here directly.
//
// LOGGING DISCIPLINE — this handler must never log req.body (the
// payload itself). The one console.error below logs only err.message,
// which comes from the Redis client / JSON stringifier, never the
// payload content.

const { createShare } = require('../../lib/shareService');
const { checkCreateShareRateLimit } = require('../../lib/rateLimit');
const { MAX_PAYLOAD_BYTES } = require('../../lib/shareConstants');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { success: withinRateLimit } = await checkCreateShareRateLimit(req);
  if (!withinRateLimit) {
    res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    return;
  }

  const payload = req.body;
  if (payload == null || typeof payload !== 'object') {
    res.status(400).json({ error: 'Request body must be a JSON object.' });
    return;
  }

  // Measured on the already-parsed body's own re-serialization, not the
  // raw request bytes — see this repo's own architecture notes on why a
  // simple post-parse size check (rather than a streaming byte-counter)
  // is an acceptable tradeoff here: Vercel's own platform-level request
  // body limit is already a hard backstop against a truly enormous
  // payload ever reaching this point.
  const byteLength = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (byteLength > MAX_PAYLOAD_BYTES) {
    res.status(413).json({ error: `Payload too large (max ${MAX_PAYLOAD_BYTES} bytes).` });
    return;
  }

  const ttlSecondsRaw = req.query?.ttlSeconds;
  const ttlSeconds = typeof ttlSecondsRaw === 'string' && /^\d+$/.test(ttlSecondsRaw)
    ? Number(ttlSecondsRaw)
    : undefined;

  try {
    const { shareId } = await createShare(payload, { ttlSeconds });
    res.status(201).json({ shareId });
  } catch (err) {
    console.error('createShare failed:', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Could not create share.' });
  }
};
