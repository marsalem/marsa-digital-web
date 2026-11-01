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

const crypto = require('crypto');
const { getRedisClient } = require('./redisClient');
const { DEFAULT_TTL_SECONDS } = require('./shareConstants');

// getRedisClient (not Redis.fromEnv() directly) — see redisClient.js's
// own header for why: this project's actual Vercel-injected env vars are
// KV_REST_API_URL/KV_REST_API_TOKEN, not the UPSTASH_REDIS_REST_* pair
// Redis.fromEnv() looks for.
const redis = getRedisClient();

const KEY_PREFIX = 'share:';

// Presence means "administratively disabled" — the share:<id> payload
// below is NOT deleted when this is the mechanism in use (see
// disableShare's own header for why). getShare checks this in addition
// to the payload key, so a disabled share reads as unavailable exactly
// like a deleted or expired one, to every caller except restoreShare.
const DISABLED_KEY_PREFIX = 'share-disabled:';

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
  // A soft-disabled share (see disableShare) still has its payload key
  // present but must read as unavailable to every caller except
  // restoreShare — same observable contract a deleted/expired share
  // already has, just via a sibling marker key instead of DEL.
  const disabled = await redis.get(DISABLED_KEY_PREFIX + shareId);
  if (disabled != null) return null;
  // Upstash's REST client already JSON-decodes string values that look
  // like JSON, so `raw` may already be an object here rather than a
  // string — handle both rather than assuming JSON.parse is always
  // needed (a redundant JSON.parse on an already-decoded value throws).
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/**
 * Returns whether shareId currently has a live, non-disabled payload —
 * used by blockCreatorForShare to decide which of a creator's shares
 * were actually still live at block-time (same question deleteShare's
 * own return value used to answer before this feature existed).
 * @param {string} shareId
 * @returns {Promise<boolean>}
 */
async function shareExists(shareId) {
  return (await getShare(shareId)) != null;
}

/**
 * Marks `shareId` administratively disabled WITHOUT deleting its
 * payload — the one difference from deleteShare, and the entire reason
 * this function exists: a disabled share can later be reversed via
 * restoreShare, whereas deleteShare's DEL is permanent by design (see
 * that function's own doc, and admin.html's Take Down confirmation,
 * which explicitly promises "this cannot be undone" — deleteShare is
 * what keeps that true; this is for the one path that must NOT be
 * permanent).
 *
 * A no-op (silently) if the underlying share no longer exists — mirrors
 * deleteShare's own "already gone is not an error" posture.
 *
 * @param {string} shareId
 * @param {string} reason — opaque to this module; stored so
 *   restoreShare can refuse to touch a share disabled for a DIFFERENT
 *   reason than the one it's asked to restore.
 * @param {number} ttlSeconds
 * @returns {Promise<boolean>} whether a live share was actually disabled
 */
async function disableShare(shareId, reason, ttlSeconds) {
  if (!(await shareExists(shareId))) return false;
  await redis.set(
    DISABLED_KEY_PREFIX + shareId,
    JSON.stringify({ reason, disabledAt: Date.now() }),
    { ex: ttlSeconds }
  );
  return true;
}

/**
 * Reverses disableShare — removes the marker so the share's own,
 * never-deleted payload becomes readable again. Only acts if the
 * share is CURRENTLY disabled for `expectedReason` specifically; a
 * share disabled for any other reason (or not disabled at all) is left
 * untouched, returning false — this is what stops an unblock from ever
 * resurrecting content that wasn't disabled by the block being reversed.
 *
 * @param {string} shareId
 * @param {string} expectedReason
 * @returns {Promise<boolean>} whether this call actually restored anything
 */
async function restoreShare(shareId, expectedReason) {
  const raw = await redis.get(DISABLED_KEY_PREFIX + shareId);
  if (raw == null) return false;
  const marker = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (marker.reason !== expectedReason) return false;
  await redis.del(DISABLED_KEY_PREFIX + shareId);
  return true;
}

/**
 * PERMANENTLY deletes the share, if any, stored under `shareId` —
 * genuinely irreversible, unlike disableShare above. This is what
 * api/admin-ui/takedown.js uses, matching that route's own UI
 * confirmation ("This cannot be undone"); the Block Creator sweep in
 * lib/creatorBlock.js deliberately uses disableShare instead, precisely
 * because that path needs to be reversible via Unblock Creator. Same
 * access model as getShare otherwise: whoever has the ID can delete it,
 * matching the "possession of the link is the credential" model this
 * whole service is built on (see this file's own PRIVACY MODEL note) —
 * there's no separate owner/auth concept to check against.
 *
 * @param {string} shareId
 * @returns {Promise<boolean>}
 */
async function deleteShare(shareId) {
  const deletedCount = await redis.del(KEY_PREFIX + shareId);
  return deletedCount > 0;
}

module.exports = { createShare, getShare, deleteShare, disableShare, restoreShare, shareExists };
