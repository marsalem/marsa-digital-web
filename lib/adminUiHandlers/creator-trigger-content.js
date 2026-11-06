// lib/adminUiHandlers/creator-trigger-content.js
// Required by api/admin-ui/[action].js (see that file's own header)
// rather than deployed as its own Vercel Function.
//
// Marsa Digital web — GET /api/admin-ui/creator-trigger-content: lets an
// administrator re-view the content of a share that was both reported
// AND contributed to a specific, currently-recorded creator block —
// i.e. exactly the "Reported content" entries
// lib/adminUiHandlers/blocked-creators.js's own `triggers` array
// surfaces, nothing more. See lib/creatorBlock.js's getTriggerContent
// for the actual authorization logic; this handler is a thin HTTP
// wrapper around it, same division of responsibility as every other
// admin-ui handler in this directory.
//
// STRICT, NARROW AUTHORIZATION — this is deliberately NOT a general
// "read any share by id" admin tool: getTriggerContent refuses any
// shareId that isn't a RECORDED TRIGGER for the SPECIFIC blockId given,
// including a live, untouched share, a different creator's content, or
// even an untouched SIBLING share of the SAME creator that was swept
// into creator-block-disabled without ever being individually reported.
// A caller cannot probe arbitrary shareIds through this endpoint for any
// purpose beyond "show me the report that got this specific, currently-
// blocked creator blocked."
//
// Query: ?blockId=<opaque blockId>&shareId=<shareId>.
// Response: the raw share payload (SAME shape as the public
// GET /api/share/:id), 404 if blockId is unknown/expired, shareId isn't
// a recorded trigger for it, or the underlying share is genuinely,
// permanently gone — never distinguished from one another in the
// response, so this can't be used to probe which specific reason a 404
// occurred for. Reuses admin.html's EXISTING preview renderer
// (AdminPreview.parseSharePayload/renderPreview) unmodified — this
// endpoint's whole reason to exist is serving that same shape from a
// different, admin-gated source.
//
// AUTH — GET, session-cookie gated like every other read-only admin-ui
// route (lib/adminUiHandlers/reports.js, blocked-creators.js); no CSRF
// header required, for the same reason those two don't require one
// either (lib/adminSession.js's own CSRF_HEADER_NAME note: a plain
// cross-site GET can't set an arbitrary header, and this performs no
// state change for CSRF to even apply to).
//
// Cache-Control: no-store — same discipline as reports.js/
// blocked-creators.js; this response can carry reporter-adjacent share
// content and must never be cached by the browser or an intermediary.

const { checkAdminRateLimit } = require('../rateLimit');
const { rejectUnlessValidSession } = require('../adminSession');
const { getTriggerContent } = require('../creatorBlock');
const { MAX_SHARE_ID_LENGTH } = require('../shareConstants');

// blockId is always a fixed-length crypto.randomBytes(8).toString('hex')
// (16 chars) in practice — same generous defensive cap
// unblock-creator.js's own MAX_BLOCK_ID_LENGTH uses, not a real expected
// length.
const MAX_BLOCK_ID_LENGTH = 128;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (await rejectUnlessValidSession(req, res)) return;

  const { success: withinRateLimit } = await checkAdminRateLimit(req);
  if (!withinRateLimit) {
    res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    return;
  }

  const { blockId, shareId } = req.query;
  if (typeof blockId !== 'string' || !blockId || blockId.length > MAX_BLOCK_ID_LENGTH) {
    res.status(400).json({ error: 'A valid blockId is required.' });
    return;
  }
  if (typeof shareId !== 'string' || !shareId || shareId.length > MAX_SHARE_ID_LENGTH) {
    res.status(400).json({ error: 'A valid shareId is required.' });
    return;
  }

  res.setHeader('Cache-Control', 'no-store');

  try {
    const payload = await getTriggerContent(blockId, shareId);
    if (payload == null) {
      res.status(404).json({ error: 'This content is not available.' });
      return;
    }
    res.status(200).json(payload);
  } catch (err) {
    console.error('admin-ui getTriggerContent failed:', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Could not load content.' });
  }
};
