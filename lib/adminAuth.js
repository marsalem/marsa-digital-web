// lib/adminAuth.js
// Marsa Digital web — authorization for the admin-only report/takedown/
// block-creator routes (api/admin/*). There is no account system and no
// existing auth mechanism anywhere else in this backend, so this
// introduces the minimal thing that works: a single shared secret
// (ADMIN_API_TOKEN, set only in Vercel's own environment variables, never
// shipped in the app or committed anywhere) checked via a standard
// `Authorization: Bearer <token>` header.
//
// FAILS CLOSED: if ADMIN_API_TOKEN isn't configured in the deployment
// environment at all, every admin route rejects every request — there is
// no "admin disabled, so allow everything" fallback. Someone (you) must
// explicitly set this env var in Vercel before these routes do anything.
//
// CONSTANT-TIME COMPARISON: uses crypto.timingSafeEqual rather than `===`
// specifically to avoid a timing side-channel on the secret itself. This
// is defense-in-depth, not a response to a demonstrated attack against
// this specific deployment (an HTTPS + serverless-cold-start environment
// already makes a remote timing attack on a short string impractical) —
// cheap to do correctly, so it's done correctly.
//
// LOGGING DISCIPLINE — never log the Authorization header or the
// configured token, in either the success or failure path.

const crypto = require('crypto');

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on unequal-length buffers rather than
  // returning false — pad the shorter one with a fixed-length buffer
  // comparison instead of short-circuiting on a cheap `.length` check,
  // so a length mismatch alone doesn't return in measurably less time
  // than a full comparison would.
  if (bufA.length !== bufB.length) {
    const padded = Buffer.alloc(Math.max(bufA.length, bufB.length, 1));
    crypto.timingSafeEqual(padded, padded); // constant-ish-time no-op
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
function isAuthorizedAdmin(req) {
  const configured = process.env.ADMIN_API_TOKEN;
  if (!configured) return false; // fail closed — see header

  const header = req.headers['authorization'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || !raw.startsWith('Bearer ')) return false;
  const presented = raw.slice('Bearer '.length).trim();
  if (!presented) return false;

  return timingSafeStringEqual(presented, configured);
}

/**
 * Shared guard for every api/admin/* handler. Returns true (and has
 * already written the 401 response) if the request was rejected — the
 * caller should `return` immediately in that case.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {boolean}
 */
function rejectUnlessAdmin(req, res) {
  if (isAuthorizedAdmin(req)) return false;
  res.status(401).json({ error: 'Unauthorized.' });
  return true;
}

module.exports = { isAuthorizedAdmin, rejectUnlessAdmin, timingSafeStringEqual };
