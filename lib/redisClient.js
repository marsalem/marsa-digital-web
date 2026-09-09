// lib/redisClient.js
// Marsa Digital web — single place that resolves which env vars actually
// hold the Upstash REST credentials, and constructs the Redis client
// from them. Both lib/shareService.js and lib/rateLimit.js import
// getRedisClient() from here rather than each calling Redis.fromEnv()
// independently, so there's exactly one spot to fix if Vercel's
// injected variable names ever change again.
//
// Why this exists instead of Redis.fromEnv(): that helper only reads
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. Connecting Upstash
// via the Vercel Marketplace integration on THIS project actually
// injects KV_REST_API_URL / KV_REST_API_TOKEN instead — Vercel's own
// "Vercel KV" product name is retired, but every store that product
// used to provision (now backed by Upstash under the hood) still uses
// its env var naming for backward compatibility with existing
// @vercel/kv-based code (confirmed via Vercel's own docs: "Vercel KV is
// no longer available... we automatically moved it to Upstash Redis").
// Checked in this order — UPSTASH_REDIS_REST_* first, then the
// KV_REST_API_* fallback — so this keeps working unmodified whichever
// naming a future reconnect/migration happens to use, without needing
// another round of "which env vars did Vercel actually create this
// time."
const { Redis } = require('@upstash/redis');

let cachedClient = null;

function getRedisClient() {
  if (cachedClient) return cachedClient;

  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    // Deliberately loud, specific failure rather than letting
    // @upstash/redis's own generic "missing credentials" error surface —
    // whoever hits this next should immediately know which env var pair
    // is missing, not have to go rediscover this file's own reasoning.
    throw new Error(
      'Redis credentials not found. Expected UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN ' +
      'or KV_REST_API_URL/KV_REST_API_TOKEN in the environment.'
    );
  }

  cachedClient = new Redis({ url, token });
  return cachedClient;
}

module.exports = { getRedisClient };
