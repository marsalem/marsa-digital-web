// api/cron/keep-alive.js
// Marsa Digital web — scheduled keep-alive ping for the Upstash Redis
// database. Upstash auto-archives Free-tier databases after a period of
// inactivity — this is exactly what took the Share Service down in
// October 2026 (confirmed via Vercel's runtime logs: `getaddrinfo
// ENOTFOUND <host>.upstash.io`, traced to the database having been
// archived, then fully deleted, and the integration itself showing
// "Uninstalled"). Real share/report traffic alone isn't frequent or
// regular enough to guarantee staying under whatever Upstash's inactivity
// window actually is — this route exists specifically to make that
// question moot by generating guaranteed daily activity regardless of
// real usage.
//
// Triggered by Vercel Cron (see vercel.json's own `crons` entry) —
// not a route any client is meant to call directly.
//
// AUTH — Vercel signs every real cron invocation with
// `Authorization: Bearer <CRON_SECRET>` once CRON_SECRET is set as a
// project Environment Variable (Vercel's own documented convention for
// securing cron routes). Fails closed, same convention as
// lib/adminAuth.js: if CRON_SECRET isn't configured, every request is
// rejected rather than silently allowed through — CRON_SECRET must be
// set in Vercel's Environment Variables for this route to ever succeed.
//
// SCOPE — deliberately minimal: writes one small, short-TTL sentinel key.
// Never touches real share/report data, never calls any other module's
// logic, nothing here can fail a real user-facing request even if this
// route itself is broken or misconfigured.

const { getRedisClient } = require('../../lib/redisClient');

const KEEPALIVE_KEY = 'keepalive:ping';
// Short-lived on purpose — this key's only job is to exist long enough to
// count as "activity" to Upstash; it has no reason to persist, and a
// short TTL means a misconfigured/stuck cron schedule can't accumulate
// stale keys.
const KEEPALIVE_TTL_SECONDS = 3600;

module.exports = async function handler(req, res) {
  const configured = process.env.CRON_SECRET;
  const auth = req.headers['authorization'];
  if (!configured || auth !== `Bearer ${configured}`) {
    res.status(401).json({ error: 'Unauthorized.' });
    return;
  }

  try {
    const redis = getRedisClient();
    await redis.set(KEEPALIVE_KEY, Date.now().toString(), { ex: KEEPALIVE_TTL_SECONDS });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('keep-alive ping failed:', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Keep-alive ping failed.' });
  }
};
