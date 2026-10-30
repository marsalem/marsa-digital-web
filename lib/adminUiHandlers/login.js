// lib/adminUiHandlers/login.js
// Relocated from api/admin-ui/login.js — now required by
// api/admin-ui/[action].js (see that file's own header) rather than
// deployed as its own Vercel Function. Logic and security checks below
// are unchanged by the move.
//
// Marsa Digital web — POST /api/admin-ui/login: the admin moderation
// UI's own sign-in. Checks ADMIN_UI_PASSWORD (never ADMIN_API_TOKEN —
// see lib/adminSession.js's own header for why these are kept separate)
// and, on success, issues a short-lived session cookie. The browser
// never receives ADMIN_UI_PASSWORD or ADMIN_API_TOKEN at any point —
// only the session id, which proves nothing beyond "logged in within
// the last SESSION_TTL_SECONDS."
//
// LOGGING DISCIPLINE — never log req.body (contains the password).
//
// FAIL CLOSED ON RATE-LIMIT-CHECK FAILURE — if Redis itself is
// unreachable, checkAdminUiLoginRateLimit() throws rather than
// resolving {success: true/false} (confirmed by reading lib/rateLimit.js:
// no try/catch around that limiter's own .limit() call). Previously
// unhandled here, which meant a Redis outage turned into an uncaught
// exception (an opaque 500/crash) on every login attempt — and more
// importantly, there was no explicit guarantee a caller couldn't somehow
// still reach the password check in that state. Caught explicitly below
// and turned into a controlled 503, with an immediate `return` before
// the password is ever checked — login cannot proceed, by construction,
// whenever the rate limiter itself can't be verified. Not a weakening of
// the limit: this path never lets a request through "assuming" it was
// within budget, it only ever stops earlier than before.
const { checkAdminUiLoginRateLimit } = require('../rateLimit');
const { isCorrectPassword, createSession, sessionCookieHeader } = require('../adminSession');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let rateLimitResult;
  try {
    rateLimitResult = await checkAdminUiLoginRateLimit(req);
  } catch (err) {
    console.error('admin-ui login rate limit check failed:', err instanceof Error ? err.message : String(err));
    res.status(503).json({ error: 'Login is temporarily unavailable. Please try again shortly.' });
    return;
  }
  if (!rateLimitResult.success) {
    res.status(429).json({ error: 'Too many attempts. Please try again shortly.' });
    return;
  }

  const body = req.body;
  const password = body && typeof body === 'object' ? body.password : undefined;

  if (!isCorrectPassword(password)) {
    res.status(401).json({ error: 'Incorrect password.' });
    return;
  }

  try {
    const sessionId = await createSession();
    res.setHeader('Set-Cookie', sessionCookieHeader(req, sessionId));
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('admin-ui login failed:', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Could not sign in.' });
  }
};
