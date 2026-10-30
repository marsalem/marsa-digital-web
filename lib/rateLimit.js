// lib/rateLimit.js
// Marsa Digital web — rate limiting for the public Share Service endpoints
// (api/share/index.js, api/share/[id].js, api/import-preview.js). All three
// are reachable by anyone, not just the Quran Atlas app, so each needs a
// cap independent of anything the app itself enforces. Reuses the SAME
// Upstash Redis instance the Share Service already talks to
// (Redis.fromEnv() — see shareService.js's own comment on the expected env
// vars) rather than provisioning a second store just for counters.
//
// LOGGING DISCIPLINE — same as shareService.js: this module's own
// bookkeeping (IP, timestamp, request count) never includes payload
// content, since it never sees the payload at all — enforced simply by
// this module having no parameter through which a payload COULD flow.
//
// ── Client-IP derivation — verified against Vercel's own current docs
// (vercel.com/docs/headers/request-headers, "x-forwarded-for" /
// "x-vercel-forwarded-for" entries), not assumed ──
//
// Vercel's docs state plainly: "If you are trying to use Vercel behind a
// proxy, we currently overwrite the X-Forwarded-For header and do not
// forward external IPs. This restriction is in place to prevent IP
// spoofing." In other words, on a standard deployment (no Enterprise
// "Trusted Proxy" add-on, no separate proxy placed in front of Vercel —
// neither of which this project uses, per vercel.json/package.json), a
// client CANNOT set its own x-forwarded-for value; Vercel's edge sets it
// to the real connecting IP regardless of what the request itself sent.
// An earlier pass at this audit assumed x-forwarded-for was
// client-spoofable on Vercel (a correct concern for a generic Node app
// behind an arbitrary reverse proxy) without checking Vercel's own
// documented behavior first — that assumption does not hold here and is
// corrected in this comment rather than silently dropped.
//
// x-vercel-forwarded-for is documented as "identical to x-forwarded-for.
// However, x-forwarded-for could be overwritten if you're using a proxy on
// top of Vercel" — i.e. it stays correct even in that one scenario where
// x-forwarded-for itself might not. Preferring it here, with
// x-forwarded-for as a fallback, is a free defensive measure for a
// configuration this project doesn't currently have (an extra proxy in
// front of Vercel), not a fix for a confirmed exploit against the current
// deployment.
function clientIp(req) {
  const header = req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return 'unknown';
  // Split on a possible proxy chain and take the LAST entry — the hop
  // closest to Vercel's own edge, and so the least likely to be a
  // client-prepended value in any configuration where the header could
  // carry more than one address. On the current (no extra proxy) setup
  // this header is already a single value, so this is a no-op; it only
  // matters if a proxy is ever added in front of Vercel.
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'unknown';
}

const { Ratelimit } = require('@upstash/ratelimit');
const { getRedisClient } = require('./redisClient');

const redis = getRedisClient();

// Sliding window, 10 requests per 60 seconds per IP. Generous enough
// that a real user tapping "Share" a few times in a row never trips it,
// tight enough to make scripted abuse (filling storage, running up
// whatever Upstash usage costs exist) impractical.
const createShareRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, '60 s'),
  prefix: 'ratelimit:share:create',
});

// Reads (GET /api/share/:id, GET /api/import-preview) are cheap per-request
// but were previously uncapped entirely — looser than the create limit
// since legitimate recipients may retry/refresh a preview page, but still
// bounded against scripted probing/flooding.
const readShareRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(60, '60 s'),
  prefix: 'ratelimit:share:read',
});

// Reports should be rare relative to shares/reads — 5 per 60s per IP is
// generous for a real recipient reporting one or two things in a row,
// tight enough that flooding the open-reports list with junk (or probing
// for which shareIds exist by watching for a different response — though
// report creation deliberately doesn't vary its response based on
// whether the shareId exists, see api/report.js) isn't cheap to do at
// volume.
const reportRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, '60 s'),
  prefix: 'ratelimit:report:create',
});

// Admin routes are already gated by lib/adminAuth.js's shared-secret
// check — this is defense-in-depth for a leaked/brute-forced token
// scenario, not the primary control. Generous enough for normal
// operator use (reviewing a batch of reports in one sitting).
const adminRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, '60 s'),
  prefix: 'ratelimit:admin',
});

// Admin UI login (api/admin-ui/login.js) specifically — deliberately
// TIGHTER than adminRateLimit above, with its own prefix/counter. The
// existing admin routes are gated by a Bearer header no browser ever
// submits via a plain form; this one guards an actual password-entry
// form, which is a lower-friction target to script a guessing campaign
// against than crafting raw Authorization headers — that difference in
// attack surface is why this gets its own, stricter limit rather than
// reusing adminRateLimit's budget.
const adminUiLoginRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, '60 s'),
  prefix: 'ratelimit:admin-ui-login',
});

/**
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<{ success: boolean }>}
 */
async function checkCreateShareRateLimit(req) {
  const { success } = await createShareRateLimit.limit(clientIp(req));
  return { success };
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<{ success: boolean }>}
 */
async function checkReadShareRateLimit(req) {
  const { success } = await readShareRateLimit.limit(clientIp(req));
  return { success };
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<{ success: boolean }>}
 */
async function checkReportRateLimit(req) {
  const { success } = await reportRateLimit.limit(clientIp(req));
  return { success };
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<{ success: boolean }>}
 */
async function checkAdminRateLimit(req) {
  const { success } = await adminRateLimit.limit(clientIp(req));
  return { success };
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<{ success: boolean }>}
 */
async function checkAdminUiLoginRateLimit(req) {
  const { success } = await adminUiLoginRateLimit.limit(clientIp(req));
  return { success };
}

module.exports = {
  checkCreateShareRateLimit,
  checkReadShareRateLimit,
  checkReportRateLimit,
  checkAdminRateLimit,
  checkAdminUiLoginRateLimit,
  clientIp,
};
