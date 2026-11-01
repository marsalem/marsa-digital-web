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
//   blocked:creator:<token>  — presence means "blocked"; value is JSON
//                              {blockedAt} (was the unused string '1'
//                              before Unblock Creator needed a
//                              displayable block date). TTL =
//                              BLOCK_TTL_SECONDS.
//   creator-shares:<token>   — a Redis SET of shareIds known to have been
//                              created by this token, used ONLY to find
//                              and disable a creator's other existing
//                              shares at the moment they're blocked — see
//                              "WHY A SET, AND WHY IT'S BOUNDED" below.
//   creator-block-id:<id>    — maps a random, OPAQUE blockId (minted at
//                              block time, no mathematical relationship
//                              to the real token) to the real token.
//                              This is the ONLY identifier the admin
//                              dashboard is ever allowed to see or send
//                              back — the real token never reaches the
//                              browser. TTL = BLOCK_TTL_SECONDS.
//   creator-token-block-id:<token> — the reverse of the mapping above,
//                              so re-blocking an already-blocked token
//                              reuses its existing blockId instead of
//                              minting (and leaking into the index) a
//                              second one. TTL = BLOCK_TTL_SECONDS.
//   creator-block-disabled:<token> — a Redis SET of shareIds that THIS
//                              specific block event actually disabled
//                              (checked live at block-time). This is
//                              what scopes Unblock Creator's restoration
//                              precisely: it is NOT the same set as
//                              creator-shares:<token> (which is purged
//                              the moment it's read) and it is never
//                              populated for a share that was already
//                              independently taken down (hard-deleted —
//                              nothing to disable) or already gone
//                              before the block ran. TTL =
//                              BLOCK_TTL_SECONDS.
//   blocked-creators:index  — a Redis SET of every currently-blocked
//                              creator's blockId, purely so the
//                              dashboard's list view has something
//                              bounded to enumerate without ever
//                              scanning the keyspace (this codebase
//                              never uses Redis KEYS/SCAN). Stale
//                              entries are filtered and opportunistically
//                              removed at read time by
//                              listBlockedCreators, not actively expired.
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

const crypto = require('crypto');
const { getRedisClient } = require('./redisClient');
const { disableShare, restoreShare, shareExists } = require('./shareService');
const { BLOCK_TTL_SECONDS } = require('./shareConstants');

const redis = getRedisClient();

const SHARE_CREATOR_KEY_PREFIX = 'share-creator:';
const BLOCKED_CREATOR_KEY_PREFIX = 'blocked:creator:';
const CREATOR_SHARES_KEY_PREFIX = 'creator-shares:';

// The reason string stored on every share disableShare() marks while
// sweeping a creator's shares — restoreShare refuses to touch a marker
// whose reason doesn't match this, which is what stops Unblock Creator
// from ever reviving a share disabled for some other reason.
const BLOCK_DISABLE_REASON = 'creator_block';

// shareIds a SPECIFIC block event actually disabled (checked live at
// block-time, same as disabledShareCount below) — NOT the same set as
// creator-shares:<token> above, which tracks "everything this token has
// ever created" and is purged the moment it's used. This one persists
// until Unblock Creator consumes it, since it's the only record of
// exactly which shares THIS block made unavailable.
const CREATOR_BLOCK_DISABLED_KEY_PREFIX = 'creator-block-disabled:';

// Opaque, random, cryptographically UNRELATED to the real creator
// token — see blockId's own note at its generation site for why the
// dashboard is only ever allowed to see this, never the token itself.
const CREATOR_BLOCK_ID_KEY_PREFIX = 'creator-block-id:';

// Reverse of the mapping above (token -> blockId) — exists ONLY so that
// re-blocking an already-blocked token (see IDEMPOTENCY above) reuses
// the same blockId instead of minting a second one, which would
// otherwise make blocked-creators:index (and the dashboard's list)
// show the same creator twice until the older blockId's TTL lapsed.
const TOKEN_BLOCK_ID_KEY_PREFIX = 'creator-token-block-id:';

// Enumerable index of currently-blocked creators' blockIds, so the
// dashboard's "Blocked Creators" list has something to iterate without
// ever scanning the keyspace (this codebase never uses Redis
// KEYS/SCAN anywhere — this SET is the same bounded-index pattern
// creator-shares:<token> above already uses). Entries aren't
// individually expired (Redis has no per-member TTL on a SET); a stale
// entry — pointing at a block that has since lapsed or been reversed —
// is filtered out, and opportunistically removed, by listBlockedCreators
// itself, the same "tolerate and filter at read time" convention
// lib/reportService.js's listOpenReports already uses for expired
// report records.
const BLOCKED_CREATORS_INDEX_KEY = 'blocked-creators:index';

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
 * from that token) and DISABLES — not deletes; see disableShare's own
 * header — every OTHER currently-live share found in that token's
 * bounded creator-shares set, then purges that tracking set. Unlike the
 * pre-Unblock-Creator version of this function, the disabled shares are
 * reversible: their shareIds are recorded in a separate, persistent
 * creator-block-disabled:<token> set specifically so unblockCreator
 * knows exactly which shares to restore later, and a random blockId
 * (unrelated to the token) is minted so the dashboard can list and act
 * on this block without ever seeing the real token. Safe to call
 * repeatedly (idempotent — see IDEMPOTENCY above).
 *
 * RELIABILITY — WRITE ORDER IS LOAD-BEARING, not incidental, in two
 * separate places below:
 *
 * (1) blockId / its two mappings / the index entry are all written
 *   BEFORE the blocked:creator:<token> enforcement flag itself, not
 *   after. If any Redis call fails partway through this function, the
 *   ONLY way isCreatorBlocked can ever return true for this token is if
 *   everything the dashboard needs to find and reverse that block
 *   (blockId + its mappings + the index entry) already, durably exists
 *   first. A failure before the enforcement flag's own write means
 *   NOTHING is enforced yet either — a clean "nothing happened" outcome,
 *   safely retried from scratch. Without this ordering, a failure
 *   between writing the flag and writing the index would leave an
 *   ACTIVE block with no blockId at all — enforced, but permanently
 *   invisible to, and unreachable from, the dashboard (confirmed as a
 *   real gap, not hypothetical, before this ordering was applied).
 *
 * (2) Inside the per-share loop, liveness is checked FIRST, and only a
 *   share that is actually live is tracked, THEN disabled — never the
 *   other way around. Both halves of that ordering matter independently:
 *   - Checking liveness first (and skipping entirely otherwise) keeps
 *     creator-block-disabled:<token> meaning exactly what it says —
 *     shares this block actually disabled — so a share that was
 *     already gone before the block (independently taken down, or
 *     naturally expired) is never tracked, never restorable, and never
 *     inflates disabledShareCount or the dashboard's own count. This
 *     is the same liveness question deleteShare's return value used to
 *     answer before this feature existed.
 *   - For a share confirmed live, tracking BEFORE disabling matters for
 *     a subtler reason: disableShare correctly refuses to re-disable
 *     (and therefore, in the opposite order, to re-track) a share it
 *     finds already disabled — so if tracking happened AFTER disabling
 *     and a crash landed between the two, NO future retry could ever
 *     recover that shareId into the tracked set, since every subsequent
 *     attempt would see it as "already disabled, nothing to do" and
 *     skip the (also already-done) tracking step that never actually
 *     ran. Tracking first means the worst a crash can leave behind is a
 *     shareId marked "in scope for this block" that isn't disabled YET
 *     — harmless, since restoreShare no-ops on a share with no disable
 *     marker at all, and a full retry of this loop (safe — see below)
 *     finishes the job either way.
 *
 * RETRY SAFETY FOR THE LOOP AS A WHOLE: sharesKey (creator-shares:
 * <token>) is only purged at the very end, AFTER the loop completes in
 * full. If this function throws anywhere inside the loop, that purge
 * never runs — so simply calling blockCreatorForShare again (for the
 * same or any other share from the same token) re-reads the SAME,
 * unchanged knownShareIds and safely re-processes every one:
 * already-disabled shares are idempotently skipped by disableShare
 * itself (and are already tracked, from point (2) above); untouched
 * ones are freshly disabled and tracked. No duplicate tracking entries
 * are possible (SADD on an existing member is a no-op), and nothing
 * outside this token's own creator-shares set is ever touched.
 *
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

  // Reuse the existing blockId if this token is already blocked (see
  // IDEMPOTENCY above) — otherwise mint a fresh one. crypto.randomBytes,
  // not a hash of the token: a hash would still be a one-way function OF
  // the secret; this has no mathematical relationship to it at all, so
  // there is nothing to derive even in principle from a blockId alone.
  let blockId = await redis.get(TOKEN_BLOCK_ID_KEY_PREFIX + token);
  if (!blockId) {
    blockId = crypto.randomBytes(8).toString('hex');
    await redis.set(TOKEN_BLOCK_ID_KEY_PREFIX + token, blockId, { ex: BLOCK_TTL_SECONDS });
  }
  await redis.set(CREATOR_BLOCK_ID_KEY_PREFIX + blockId, token, { ex: BLOCK_TTL_SECONDS });
  await redis.sadd(BLOCKED_CREATORS_INDEX_KEY, blockId);

  // The enforcement flag — deliberately LAST among the four writes
  // above, not first. See this function's own RELIABILITY note (1).
  await redis.set(BLOCKED_CREATOR_KEY_PREFIX + token, JSON.stringify({ blockedAt: Date.now() }), { ex: BLOCK_TTL_SECONDS });

  const sharesKey = CREATOR_SHARES_KEY_PREFIX + token;
  const disabledKey = CREATOR_BLOCK_DISABLED_KEY_PREFIX + token;
  const knownShareIds = await redis.smembers(sharesKey);
  let disabledShareCount = 0;
  for (const id of knownShareIds) {
    // Liveness checked first, THEN tracked, THEN disabled — see this
    // function's own RELIABILITY note (2) for why both halves of this
    // order matter independently.
    if (!(await shareExists(id))) continue;
    await redis.sadd(disabledKey, id);
    const disabled = await disableShare(id, BLOCK_DISABLE_REASON, BLOCK_TTL_SECONDS);
    if (disabled) disabledShareCount += 1;
  }
  await redis.expire(disabledKey, BLOCK_TTL_SECONDS);
  await redis.del(sharesKey);

  return { blocked: true, disabledShareCount };
}

/**
 * Lists every currently-blocked creator for the admin dashboard. Never
 * returns a real creator token — only the opaque blockId minted at
 * block-time, the block timestamp, and how many shares are currently
 * disabled because of it. Stale entries (the underlying block already
 * expired or was reversed through some other path) are silently
 * skipped AND removed from the index, same self-healing posture as
 * everything else bounded-index-shaped in this codebase.
 * @returns {Promise<Array<{ blockId: string, blockedAt: number, disabledShareCount: number }>>}
 */
async function listBlockedCreators() {
  const blockIds = await redis.smembers(BLOCKED_CREATORS_INDEX_KEY);
  const result = [];
  for (const blockId of blockIds) {
    const token = await redis.get(CREATOR_BLOCK_ID_KEY_PREFIX + blockId);
    if (!token) { await redis.srem(BLOCKED_CREATORS_INDEX_KEY, blockId); continue; }
    const blockedRaw = await redis.get(BLOCKED_CREATOR_KEY_PREFIX + token);
    if (blockedRaw == null) { await redis.srem(BLOCKED_CREATORS_INDEX_KEY, blockId); continue; }
    const blockedInfo = typeof blockedRaw === 'string' ? JSON.parse(blockedRaw) : blockedRaw;
    const disabledShareIds = await redis.smembers(CREATOR_BLOCK_DISABLED_KEY_PREFIX + token);
    result.push({ blockId, blockedAt: blockedInfo.blockedAt, disabledShareCount: disabledShareIds.length });
  }
  return result;
}

/**
 * Reverses blockCreatorForShare, identified by the opaque blockId (the
 * only identifier the dashboard ever holds — see that function's own
 * note on why). Restores exactly the shares THIS block disabled, and
 * only if they're still disabled for that same reason (restoreShare's
 * own guard) — never touches a share taken down independently (it was
 * never given a disable marker at all) or disabled before this block
 * for some other reason.
 *
 * IDEMPOTENT / RETRY-SAFE BY CONSTRUCTION: every step below is a no-op
 * if already done (restoreShare on an already-restored share, del on an
 * already-gone key, srem on an already-removed member) — so if this
 * throws partway through (e.g. a transient Redis error), simply calling
 * it again with the same blockId safely finishes the remaining work
 * without double-restoring or corrupting anything. No explicit
 * rollback/transaction machinery is needed for that reason.
 *
 * @param {string} blockId
 * @returns {Promise<{ unblocked: boolean, reason?: string, restoredShareCount?: number }>}
 */
async function unblockCreator(blockId) {
  const token = await redis.get(CREATOR_BLOCK_ID_KEY_PREFIX + blockId);
  if (!token) {
    return { unblocked: false, reason: 'This creator is not currently blocked (already unblocked, or the block has expired).' };
  }

  const disabledKey = CREATOR_BLOCK_DISABLED_KEY_PREFIX + token;
  const disabledShareIds = await redis.smembers(disabledKey);
  let restoredShareCount = 0;
  for (const id of disabledShareIds) {
    const restored = await restoreShare(id, BLOCK_DISABLE_REASON);
    if (restored) restoredShareCount += 1;
  }

  await redis.del(disabledKey);
  await redis.del(BLOCKED_CREATOR_KEY_PREFIX + token);
  await redis.del(CREATOR_BLOCK_ID_KEY_PREFIX + blockId);
  await redis.del(TOKEN_BLOCK_ID_KEY_PREFIX + token);
  await redis.srem(BLOCKED_CREATORS_INDEX_KEY, blockId);

  return { unblocked: true, restoredShareCount };
}

module.exports = { isCreatorBlocked, recordShareCreator, blockCreatorForShare, listBlockedCreators, unblockCreator };
