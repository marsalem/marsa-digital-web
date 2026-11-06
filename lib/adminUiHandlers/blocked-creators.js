// lib/adminUiHandlers/blocked-creators.js
// Required by api/admin-ui/[action].js (see that file's own header)
// rather than deployed as its own Vercel Function.
//
// Marsa Digital web — GET /api/admin-ui/blocked-creators: list every
// currently-blocked creator for the admin dashboard's "Blocked
// Creators" view. Session-cookie gated — no CSRF header required, same
// as lib/adminUiHandlers/reports.js (a read-only GET, nothing to forge).
//
// Response: { creators: Array<{ blockId, blockedAt, disabledShareCount, reasons }> }
// — never the real creator token. blockId is the opaque, cryptographically
// unrelated identifier lib/creatorBlock.js mints at block time; see that
// file's own header for why the real token never reaches the browser.
// `reasons` is a (possibly empty) array of REPORT_REASONS enum values —
// never free-text report `details`, never a reportId — see
// creatorBlock.js's own creator-block-reasons:<token> note.
//
// Cache-Control: no-store — same discipline as reports.js.

const { checkAdminRateLimit } = require('../rateLimit');
const { rejectUnlessValidSession } = require('../adminSession');
const { listBlockedCreators } = require('../creatorBlock');

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

  res.setHeader('Cache-Control', 'no-store');

  try {
    const creators = await listBlockedCreators();
    res.status(200).json({ creators });
  } catch (err) {
    console.error('admin-ui listBlockedCreators failed:', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Could not list blocked creators.' });
  }
};
