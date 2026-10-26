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
const { MAX_PAYLOAD_BYTES, DEFAULT_TTL_SECONDS } = require('../../lib/shareConstants');
const { validateSharePayload } = require('../../lib/shareSchema');
const { checkContent } = require('../../lib/contentFilter');
const { isCreatorBlocked, recordShareCreator } = require('../../lib/creatorBlock');
const { sanitizeSharePayload } = require('../../lib/noteSanitizer');

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

  // Creator-token block check — see lib/creatorBlock.js's own header for
  // the full design (backward compatibility, what this does/doesn't
  // achieve). The rejection message is deliberately IDENTICAL to the
  // content-filter rejection below, so a blocked creator can't use the
  // response text to confirm "I'm blocked" vs. "my content was filtered."
  const creatorTokenHeader = req.headers['x-creator-token'];
  const creatorToken = Array.isArray(creatorTokenHeader) ? creatorTokenHeader[0] : creatorTokenHeader;
  if (await isCreatorBlocked(creatorToken)) {
    res.status(400).json({ error: 'This content can\'t be shared.' });
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

  // Shape/structural validation — see lib/shareSchema.js's own header for
  // why this runs only on write, never on read: existing stored shares
  // (including at least one pre-dating this check) must keep resolving
  // exactly as before. `reason` is always a short structural description,
  // never anything derived from the payload's own content.
  const { valid, reason } = validateSharePayload(payload);
  if (!valid) {
    res.status(400).json({ error: reason });
    return;
  }

  // Content filter — runs AFTER shape validation (so it only ever walks
  // an already depth/array-bounded tree) and returns a fixed, generic
  // error — see lib/contentFilter.js's own LOGGING DISCIPLINE note: the
  // matched category must never reach the client or a log line.
  const { allowed } = checkContent(payload);
  if (!allowed) {
    res.status(400).json({ error: 'This content can\'t be shared.' });
    return;
  }

  const ttlSecondsRaw = req.query?.ttlSeconds;
  const ttlSeconds = typeof ttlSecondsRaw === 'string' && /^\d+$/.test(ttlSecondsRaw)
    ? Number(ttlSecondsRaw)
    : undefined;

  // Server-side image-URI backstop — see lib/noteSanitizer.js's own
  // header for why this exists despite the client already doing the same
  // thing: this is a public, unauthenticated endpoint, so this is the
  // one place the guarantee holds for every caller, not just an updated
  // app build. Runs last, as a storage-time transform, after validation
  // and the content filter have both already accepted the payload — it
  // never rejects anything itself.
  const sanitizedPayload = sanitizeSharePayload(payload);

  try {
    const { shareId } = await createShare(sanitizedPayload, { ttlSeconds });
    // Best-effort: a failure here must never fail the share itself (the
    // share was already written successfully) — see creatorBlock.js's
    // own no-op-if-no-token contract; a thrown error here is a Redis
    // hiccup, not a validation failure, so it's logged and swallowed
    // rather than surfaced as a 500 for a share that actually succeeded.
    try {
      await recordShareCreator(shareId, creatorToken, ttlSeconds ?? DEFAULT_TTL_SECONDS);
    } catch (err) {
      console.error('recordShareCreator failed:', err instanceof Error ? err.message : String(err));
    }
    res.status(201).json({ shareId });
  } catch (err) {
    console.error('createShare failed:', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Could not create share.' });
  }
};
