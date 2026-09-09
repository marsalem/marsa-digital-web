// lib/redisClient.js
// Marsa Digital web — single place that resolves which env vars actually
// hold the Upstash REST credentials, and constructs the Redis client
// from them. Both lib/shareService.js and lib/rateLimit.js import
// getRedisClient() from here rather than each calling Redis.fromEnv()
// independently, so there's exactly one spot to fix if Vercel's
// injected variable names ever change again.
//
// Why this exists instead of Redis.fromEnv(): that helper only reads
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.
//
// Checked in this order, first match wins:
//   1. UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN — the
//      @upstash/redis SDK's own documented names.
//   2. KV_REST_API_URL / KV_REST_API_TOKEN — the retired "Vercel KV"
//      product's naming, kept for backward compatibility with existing
//      @vercel/kv-based code even though the store itself is Upstash
//      under the hood (per Vercel's own docs: "Vercel KV is no longer
//      available... we automatically moved it to Upstash Redis").
//   3. UPSTASH_REDIS_REST_KV_REST_API_URL / _TOKEN — confirmed via this
//      project's own Vercel Environment Variables page (not guessed):
//      an earlier custom-prefix configuration on this specific
//      integration produced this exact doubled-up name instead of
//      either convention above.
// Verified ground truth over guessing at every step here — (1) and (2)
// were each tried and found wrong in production before landing on (3).
// Kept as a fallback CHAIN (not just switched to whichever one is
// currently deployed) so this keeps working unmodified through any
// future reconnect, whichever of the three conventions it happens to
// produce, without another round of "which env vars did Vercel actually
// create this time."
const { Redis } = require('@upstash/redis');

let cachedClient = null;

function getRedisClient() {
  if (cachedClient) return cachedClient;

  const url = process.env.UPSTASH_REDIS_REST_URL
    || process.env.KV_REST_API_URL
    || process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
    || process.env.KV_REST_API_TOKEN
    || process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;

  if (!url || !token) {
    // Deliberately loud, specific failure rather than letting
    // @upstash/redis's own generic "missing credentials" error surface —
    // whoever hits this next should immediately know which env var pairs
    // were checked, not have to go rediscover this file's own reasoning.
    throw new Error(
      'Redis credentials not found. Expected one of: ' +
      'UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN, ' +
      'KV_REST_API_URL/KV_REST_API_TOKEN, or ' +
      'UPSTASH_REDIS_REST_KV_REST_API_URL/UPSTASH_REDIS_REST_KV_REST_API_TOKEN ' +
      'in the environment.'
    );
  }

  cachedClient = new Redis({ url, token });
  return cachedClient;
}

module.exports = { getRedisClient };
