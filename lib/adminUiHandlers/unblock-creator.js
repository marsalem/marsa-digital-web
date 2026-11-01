// lib/adminUiHandlers/unblock-creator.js
// Required by api/admin-ui/[action].js (see that file's own header)
// rather than deployed as its own Vercel Function.
//
// Marsa Digital web — POST /api/admin-ui/unblock-creator: reverses a
// creator block. Session-cookie + CSRF-header gated, same as every
// other state-changing admin-ui route.
//
// Body: { blockId: string } — the OPAQUE identifier
// lib/adminUiHandlers/blocked-creators.js's listing returned; never the
// real creator token (the browser never holds that, and never needs
// to — see lib/creatorBlock.js's own header).
//
// Response: { unblocked: boolean, reason?: string, restoredShareCount?: number }
// — unblocked:false (with a reason) when blockId doesn't correspond to
// a currently-active block (already unblocked, or naturally expired);
// this is the expected, non-error outcome for that case, not a 404 —
// mirrors lib/adminUiHandlers/block-creator.js's own blocked:false
// convention exactly.

const { checkAdminRateLimit } = require('../rateLimit');
const { rejectUnlessValidSession, rejectUnlessSameOriginHeader } = require('../adminSession');
const { unblockCreator } = require('../creatorBlock');

// blockId is always a fixed-length crypto.randomBytes(8).toString('hex')
// (16 chars) in practice; this is a generous defensive cap against a
// malformed/oversized request body, not a real expected length.
const MAX_BLOCK_ID_LENGTH = 128;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (await rejectUnlessValidSession(req, res)) return;
  if (rejectUnlessSameOriginHeader(req, res)) return;

  const { success: withinRateLimit } = await checkAdminRateLimit(req);
  if (!withinRateLimit) {
    res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    return;
  }

  const body = req.body;
  const blockId = body && typeof body === 'object' ? body.blockId : undefined;
  if (typeof blockId !== 'string' || !blockId || blockId.length > MAX_BLOCK_ID_LENGTH) {
    res.status(400).json({ error: 'A valid blockId is required.' });
    return;
  }

  try {
    const result = await unblockCreator(blockId);
    res.status(200).json(result);
  } catch (err) {
    console.error('admin-ui unblockCreator failed:', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Could not unblock creator.' });
  }
};
