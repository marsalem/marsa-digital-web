// lib/rateLimit.js
// Marsa Digital web — rate limiting for the public createShare endpoint
// (api/share/index.js). `POST /api/share` is reachable by anyone, not
// just the Quran Atlas app, so it needs a cap independent of anything
// the app itself enforces. Reuses the SAME Upstash Redis instance the
// Share Service already talks to (Redis.fromEnv() — see shareService.js's
// own comment on the expected env vars) rather than provisioning a
// second store just for counters.
//
// Sliding window, 10 requests per 60 seconds per IP. Generous enough
// that a real user tapping "Share" a few times in a row never trips it,
// tight enough to make scripted abuse (filling storage, running up
// whatever Upstash usage costs exist) impractical.
//
// LOGGING DISCIPLINE — same as shareService.js: this module's own
// bookkeeping (IP, timestamp, request count) never includes payload
// content, since it never sees the payload at all — enforced simply by
// this module having no parameter through which a payload COULD flow.

const { Ratelimit } = require('@upstash/ratelimit');
const { getRedisClient } = require('./redisClient');

const redis = getRedisClient();

const createShareRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, '60 s'),
  prefix: 'ratelimit:share:create',
});

/**
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<{ success: boolean }>}
 */
async function checkCreateShareRateLimit(req) {
  // x-forwarded-for is the standard client-IP header on Vercel's
  // serverless functions (the platform sits in front as a proxy) — may
  // carry a comma-separated chain if the request passed through further
  // proxies, so only the first (original client) address is used.
  const forwardedFor = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)?.split(',')[0]?.trim() || 'unknown';
  const { success } = await createShareRateLimit.limit(ip);
  return { success };
}

module.exports = { checkCreateShareRateLimit };
