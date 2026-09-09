// lib/shareService.js
// Marsa Digital web — Share Service: the ONLY module in this repo that
// talks to Redis. Every other file (the api/share/* route handlers,
// eventually Quran Atlas's own app code via HTTP) goes through
// createShare/getShare/deleteShare below and never sees a Redis client
// directly — see this repo's own architecture note (Quran Atlas's
// Playlist Share feature) for why: the URL a share link carries must
// only ever be a short, opaque ID, never the payload itself, regardless
// of how large that payload is. Putting the storage boundary here, not
// at the HTTP layer, is what keeps that true uniformly instead of by
// convention.
//
// Deliberately payload-shape-agnostic: this module stores and returns
// arbitrary JSON and never inspects it. Quran Atlas's own payload
// envelopes already carry their own `type` discriminator (qatlas_
// playlist/qatlas_topic/qatlas_cards/...) — that's a concern for
// whatever calls getShare, not this module. Adding a new shareable
// object type later never requires a change here.
//
// PRIVACY MODEL — read before changing anything below: a share ID is an
// UNGUESSABLE LINK, not an authenticated credential. Anyone who has the
// ID (via the share URL) can read the payload until it expires; there is
// no per-recipient auth, login, or access list. This is the same model
// Google Docs/Notion/Figma "anyone with the link" sharing uses. Nothing
// in this module (or the API routes built on it) should ever imply
// stronger privacy than that — see import.html's own note on this same
// point for the user-facing side.
//
// LOGGING DISCIPLINE — read before adding a console.log/error anywhere
// in this module or its callers: payload CONTENTS must never be logged,
// including in error paths, rate-limit metadata, or analytics. Log only
// metadata (byte size, shareId, timestamps, error messages from the
// Redis client itself, which never include the payload). A shared
// Playlist/Topic/Reference Card may contain personal reflections.

const { Redis } = require('@upstash/redis');
const crypto = require('crypto');
const { DEFAULT_TTL_SECONDS } = require('./shareConstants');

// Redis.fromEnv() reads UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
// — the standard env var names the @upstash/redis SDK expects, and what
// Upstash's own Vercel Marketplace integration should inject into this
// project once connected (Vercel dashboard → this project → Storage →
// Connect Database → Upstash for Redis). If that integration ever names
// them differently, either alias them in Vercel's own Environment
// Variables settings or adjust this one call — nothing else in this
// module depends on the exact var names.
const redis = Redis.fromEnv();

const KEY_PREFIX = 'share:';

// 16 bytes (128 bits) of crypto-strength randomness, base64url-encoded
// (22 chars, no padding, URL-safe with no escaping needed) — short
// enough to sit comfortably in a link, and well past the entropy needed
// for "nobody will ever guess or enumerate this," which is the entire
// access-control model here (see this file's own PRIVACY MODEL note).
function generateShareId() {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * Stores `payload` (any JSON-serializable value) under a freshly-minted
 * share ID and returns that ID. Throws if the Redis write fails — the
 * caller (api/share/index.js) is responsible for turning that into an
 * HTTP error response; this function itself never touches req/res.
 *
 * @param {unknown} payload
 * @param {{ ttlSeconds?: number }} [options]
 * @returns {Promise<{ shareId: string }>}
 */
async function createShare(payload, options = {}) {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const shareId = generateShareId();
  await redis.set(KEY_PREFIX + shareId, JSON.stringify(payload), { ex: ttlSeconds });
  return { shareId };
}

/**
 * Returns the payload stored under `shareId`, or null if it was never
 * created, has already expired (Redis's own TTL handles this — no
 * expiry check needed here), or has been deleted.
 *
 * @param {string} shareId
 * @returns {Promise<unknown | null>}
 */
async function getShare(shareId) {
  const raw = await redis.get(KEY_PREFIX + shareId);
  if (raw == null) return null;
  // Upstash's REST client already JSON-decodes string values that look
  // like JSON, so `raw` may already be an object here rather than a
  // string — handle both rather than assuming JSON.parse is always
  // needed (a redundant JSON.parse on an already-decoded value throws).
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/**
 * Deletes the share, if any, stored under `shareId`. Returns whether a
 * share actually existed to delete — NOT currently wired to a public
 * API route (nothing calls it yet), kept here only so the interface is
 * complete and a future "delete my share" feature is a route addition,
 * not a redesign. Same access model as getShare: whoever has the ID can
 * delete it, matching the "possession of the link is the credential"
 * model this whole service is built on (see this file's own PRIVACY
 * MODEL note) — there's no separate owner/auth concept to check against.
 *
 * @param {string} shareId
 * @returns {Promise<boolean>}
 */
async function deleteShare(shareId) {
  const deletedCount = await redis.del(KEY_PREFIX + shareId);
  return deletedCount > 0;
}

module.exports = { createShare, getShare, deleteShare };
