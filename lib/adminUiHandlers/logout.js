// lib/adminUiHandlers/logout.js
// Relocated from api/admin-ui/logout.js — now required by
// api/admin-ui/[action].js (see that file's own header) rather than
// deployed as its own Vercel Function. Logic and security checks below
// are unchanged by the move.
//
// Marsa Digital web — POST /api/admin-ui/logout: invalidates the
// current session server-side (not just clearing the cookie client-side
// — a logged-out session id must actually stop working if it's ever
// replayed). Idempotent: logging out with no session, or an
// already-invalid one, is a harmless no-op, not an error.

const { readSessionCookie, destroySession, clearSessionCookieHeader, rejectUnlessSameOriginHeader } = require('../adminSession');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (rejectUnlessSameOriginHeader(req, res)) return;

  const id = readSessionCookie(req);
  try {
    await destroySession(id);
  } catch (err) {
    console.error('admin-ui logout failed:', err instanceof Error ? err.message : String(err));
    // Still clear the cookie client-side even if the Redis delete
    // failed — a stuck server-side session is a smaller problem than a
    // browser that thinks it's still logged out but isn't.
  }
  res.setHeader('Set-Cookie', clearSessionCookieHeader(req));
  res.status(200).json({ ok: true });
};
