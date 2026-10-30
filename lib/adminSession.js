// lib/adminSession.js
// Marsa Digital web — server-side session support for the admin
// moderation UI (quran-atlas/admin.html + api/admin-ui/*). Entirely
// independent of lib/adminAuth.js's Bearer-token model used by the
// existing api/admin/* routes — those routes, and this file's own
// imported timingSafeStringEqual, are UNCHANGED by this addition. This
// is a separate credential (ADMIN_UI_PASSWORD, never ADMIN_API_TOKEN)
// and a separate verification mechanism: a short-lived, server-issued,
// random session id stored in Redis and presented back via a cookie —
// specifically so the browser never holds anything as powerful as a raw
// API token, only a revocable, time-bounded session id that proves
// nothing beyond "this browser logged in with the UI password within
// the last SESSION_TTL_SECONDS."
//
// DATA MODEL: admin-session:<id> -> '1', TTL = SESSION_TTL_SECONDS.
// Presence alone means "valid" — same convention as creatorBlock.js's
// blocked:creator:<token> keys. No session metadata (IP, user agent,
// login time) is stored; this is a single-operator tool with no need
// for a session registry beyond "is this one still valid."
//
// COOKIE: HttpOnly + SameSite=Strict always. `Secure` is applied only
// when the request actually arrived over HTTPS (checked via Vercel's own
// `x-forwarded-proto` header, not assumed) — a hardcoded `Secure` would
// make the cookie silently never-sent under local `vercel dev` (plain
// http://localhost), breaking local testing with no visible error. This
// way the same code is correct locally AND once deployed, with nothing
// to remember to toggle.
//
// LOGGING DISCIPLINE — never log a session id, cookie value, or
// ADMIN_UI_PASSWORD, in either the success or failure path.

const crypto = require('crypto');
const { getRedisClient } = require('./redisClient');
const { timingSafeStringEqual } = require('./adminAuth');

const redis = getRedisClient();

const SESSION_KEY_PREFIX = 'admin-session:';
const COOKIE_NAME = 'admin_session';
// 4 hours — meaningfully shorter than every other TTL in this codebase
// (shares/reports/blocks all run up to a year), since this is the most
// sensitive credential surface in the system. Forces periodic re-login
// rather than an indefinitely-valid browser session.
const SESSION_TTL_SECONDS = 4 * 60 * 60;

// Custom header every state-changing /api/admin-ui/* request must carry
// — CSRF defense-in-depth alongside SameSite=Strict. A plain cross-site
// <form> POST cannot set an arbitrary header without triggering a CORS
// preflight this API never opts into, so a request missing this header
// cannot be a forged cross-site submission riding the admin's cookie.
const CSRF_HEADER_NAME = 'x-admin-ui-request';

function generateSessionId() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * @param {string | undefined | null} password
 * @returns {boolean}
 */
function isCorrectPassword(password) {
  const configured = process.env.ADMIN_UI_PASSWORD;
  if (!configured) return false; // fail closed — same convention as adminAuth.js's own isAuthorizedAdmin
  if (!password) return false;
  return timingSafeStringEqual(password, configured);
}

/**
 * @returns {Promise<string>} the new session id — the raw value to set as the cookie
 */
async function createSession() {
  const id = generateSessionId();
  await redis.set(SESSION_KEY_PREFIX + id, '1', { ex: SESSION_TTL_SECONDS });
  return id;
}

/**
 * @param {string | undefined | null} id
 * @returns {Promise<boolean>}
 */
async function isValidSession(id) {
  if (!id) return false;
  const value = await redis.get(SESSION_KEY_PREFIX + id);
  return value != null;
}

/**
 * @param {string | undefined | null} id
 * @returns {Promise<void>}
 */
async function destroySession(id) {
  if (!id) return;
  await redis.del(SESSION_KEY_PREFIX + id);
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {string | null}
 */
function readSessionCookie(req) {
  const header = req.headers['cookie'];
  if (!header) return null;
  const parts = String(header).split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === COOKIE_NAME) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
function isHttpsRequest(req) {
  const proto = req.headers['x-forwarded-proto'];
  return proto === 'https' || (Array.isArray(proto) && proto.includes('https'));
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {string} id
 * @returns {string} a Set-Cookie header value
 */
function sessionCookieHeader(req, id) {
  const secure = isHttpsRequest(req) ? ' Secure;' : '';
  return `${COOKIE_NAME}=${encodeURIComponent(id)}; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {string} a Set-Cookie header value that clears the session cookie
 */
function clearSessionCookieHeader(req) {
  const secure = isHttpsRequest(req) ? ' Secure;' : '';
  return `${COOKIE_NAME}=; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=0`;
}

/**
 * Shared guard for every api/admin-ui/* handler except login. Returns
 * true (and has already written the 401 response) if the request was
 * rejected — the caller should `return` immediately in that case. Mirrors
 * lib/adminAuth.js's rejectUnlessAdmin shape exactly, just checking a
 * session cookie instead of a Bearer header.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {Promise<boolean>}
 */
async function rejectUnlessValidSession(req, res) {
  const id = readSessionCookie(req);
  if (await isValidSession(id)) return false;
  res.status(401).json({ error: 'Unauthorized.' });
  return true;
}

/**
 * Shared CSRF guard for every state-changing api/admin-ui/* handler. See
 * CSRF_HEADER_NAME's own comment above for why this header's mere
 * presence is a meaningful check. Returns true (and has already written
 * the 403 response) if the request was rejected.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {boolean}
 */
function rejectUnlessSameOriginHeader(req, res) {
  if (req.headers[CSRF_HEADER_NAME]) return false;
  res.status(403).json({ error: 'Forbidden.' });
  return true;
}

module.exports = {
  isCorrectPassword,
  createSession,
  isValidSession,
  destroySession,
  readSessionCookie,
  sessionCookieHeader,
  clearSessionCookieHeader,
  rejectUnlessValidSession,
  rejectUnlessSameOriginHeader,
  CSRF_HEADER_NAME,
  SESSION_TTL_SECONDS,
};
