// lib/creatorBlock.js
// Marsa Digital web — server-side enforcement half of the creator-
// blocking design. See the Stage 3 report for the original design
// writeup (what this does and doesn't achieve, privacy tradeoffs,
// reinstall-evasion limitation) and the Stage 3.1 report for why the
// creator-to-share index below was added — this file is the mechanical
// implementation only.
//
// DATA MODEL:
//   share-creator:<shareId>  — the creator token that made this share,
//                              IF the client sent one (see below). TTL
//                              matches the share's own TTL — this record
//                              disappears exactly when the share itself
//                              does, never outliving it.
//   blocked:creator:<token>  — presence alone means "blocked"; value is
//                              unused ('1'). TTL = BLOCK_TTL_SECONDS.
//   creator-shares:<token>   — a Redis SET of shareIds known to have been
//                              created by this token, used ONLY to find
//                              and disable a creator's other existing
//                              shares at the moment they're blocked — see
//                              "WHY A SET, AND WHY IT'S BOUNDED" below.
//
// BACKWARD COMPATIBILITY — load-bearing, not incidental: the creator
// token is a NEW, OPTIONAL client header (X-Creator-Token). Any request
// without it (an app version that predates this feature, or any other
// caller of this public API) is NOT blocked and NOT treated as
// suspicious — there's simply nothing to check or record. Rejecting
// un-tokened requests would break every existing app install overnight;
// that is never acceptable here. The practical consequence: a share
// created without a token can never later have its creator blocked or
// have its sibling shares found (there's nothing to look up) — see
// isCreatorBlocked's/recordShareCreator's own per-function note.
//
// WHY A SET, AND WHY IT'S BOUNDED (Stage 3.1) — Stage 3 originally kept
// NO token -> shares index at all, by design, specifically to avoid
// "storing more about a creator than needed." That turned out to be
// insufficient for the stated goal of this follow-up: blocking a creator
// should also disable their OTHER existing shares, which share-creator's
// one-directional (shareId -> token) record cannot answer — there is no
// cheap way to enumerate "every shareId this token has ever created"
// without some reverse index. This SET is the minimal version of that
// index, bounded two ways so it never becomes a permanent activity log:
//   1. TTL, refreshed (not reset to a fixed calendar date) on every new
//      share from that token, same ttlSeconds as the share itself
//      (sliding window, capped at BLOCK_TTL_SECONDS/DEFAULT_TTL_SECONDS
//      — 1 year, same ceiling every other retention period in this
//      service already uses). A creator who stops sharing for a full
//      year has this set expire along with everything else about them;
//      it is NOT "forever," even though Redis sets have no native
//      per-member TTL.
//   2. DELETED entirely the moment it's actually used (blockCreatorForShare
//      purges it after disabling whatever shares it found) — it only
//      needs to exist long enough to serve ONE lookup at block-time, not
//      to persist as a historical record afterward.
// Net effect: at any given moment, this tracks "this token's shares
// created within roughly the last year, that haven't yet been
// blocked-and-purged" — not an indefinite log of everything a creator
// has ever shared.
//
// EXPIRED SHARES — handled for free, not specially: deleteShare's own
// redis.del() is a no-op (returns false) on a key that's already gone,
// whether that's because it was already taken down or because its own
// TTL already lapsed naturally. blockCreatorForShare's disabledShareCount
// below only counts shares that were ACTUALLY still live at block-time.
//
// IDEMPOTENCY — calling blockCreatorForShare twice for the same reported
// shareId is safe: the second call re-sets the (already-set) block flag,
// finds the creator-shares set already emptied/deleted by the first
// call, and reports disabledShareCount: 0 — never double-counts, never
// errors on an already-blocked token or an already-deleted share.
//
// LOGGING DISCIPLINE — never log the token value itself in any message;
// shareId/boolean/count results are fine.

const { getRedisClient } = require('./redisClient');
const { deleteShare } = require('./shareService');
const { BLOCK_TTL_SECONDS } = require('./shareConstants');

const redis = getRedisClient();

const SHARE_CREATOR_KEY_PREFIX = 'share-creator:';
const BLOCKED_CREATOR_KEY_PREFIX = 'blocked:creator:';
const CREATOR_SHARES_KEY_PREFIX = 'creator-shares:';

/**
 * @param {string | undefined | null} token
 * @returns {Promise<boolean>}
 */
async function isCreatorBlocked(token) {
  if (!token) return false; // no token presented — see BACKWARD COMPATIBILITY above
  const value = await redis.get(BLOCKED_CREATOR_KEY_PREFIX + token);
  return value != null;
}

/**
 * Records which creator token made `shareId`, and adds `shareId` to that
 * token's bounded creator-shares set (see this file's own "WHY A SET, AND
 * WHY IT'S BOUNDED" note) — a no-op if the client didn't send a token;
 * see BACKWARD COMPATIBILITY above.
 * @param {string} shareId
 * @param {string | undefined | null} token
 * @param {number} ttlSeconds — same TTL as the share itself, so the
 *   share-creator record never outlives the content it points to, and
 *   the creator-shares set's own TTL slides to match the most recent
 *   share's window.
 * @returns {Promise<void>}
 */
async function recordShareCreator(shareId, token, ttlSeconds) {
  if (!token) return;
  await redis.set(SHARE_CREATOR_KEY_PREFIX + shareId, token, { ex: ttlSeconds });
  await redis.sadd(CREATOR_SHARES_KEY_PREFIX + token, shareId);
  await redis.expire(CREATOR_SHARES_KEY_PREFIX + token, ttlSeconds);
}

/**
 * Blocks the creator token that made `shareId` (stopping any FUTURE share
 * from that token) and disables every OTHER currently-live share found in
 * that token's bounded creator-shares set, then purges the set — see this
 * file's own header for the full reasoning. Safe to call repeatedly
 * (idempotent — see IDEMPOTENCY above).
 * @param {string} shareId
 * @returns {Promise<{ blocked: boolean, reason?: string, disabledShareCount?: number }>}
 *   blocked:false with a reason when there's no recorded creator token to
 *   block at all (share predates this feature, or came from an older app
 *   version) — nothing else happens in that case.
 */
async function blockCreatorForShare(shareId) {
  const token = await redis.get(SHARE_CREATOR_KEY_PREFIX + shareId);
  if (!token) {
    return { blocked: false, reason: 'No creator token is associated with this share — it may predate this feature or come from an older app version.' };
  }
  await redis.set(BLOCKED_CREATOR_KEY_PREFIX + token, '1', { ex: BLOCK_TTL_SECONDS });

  const sharesKey = CREATOR_SHARES_KEY_PREFIX + token;
  const knownShareIds = await redis.smembers(sharesKey);
  let disabledShareCount = 0;
  for (const id of knownShareIds) {
    const deleted = await deleteShare(id);
    if (deleted) disabledShareCount += 1;
  }
  await redis.del(sharesKey);

  return { blocked: true, disabledShareCount };
}

module.exports = { isCreatorBlocked, recordShareCreator, blockCreatorForShare };
