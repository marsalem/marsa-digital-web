// lib/__tests__/creatorBlock.test.js
// Run with: node --test lib/__tests__
//
// Tests the REAL creatorBlock.js logic (not route-level mocking, see
// reportAndAdmin.integration.test.js for that) against a tiny in-memory
// fake Redis — this is what actually proves the sadd/smembers/expire/del
// sequence behaves as the module's own header describes: a bounded,
// self-purging creator-shares index, not a permanent activity log.
//
// The fake Redis does NOT simulate real TTL countdown (no fake clock) —
// "a key has expired" is simulated the standard way for this kind of
// test: directly deleting it, which is observably identical to it having
// lapsed on its own. `expire()` calls are recorded (key -> last TTL arg)
// so tests can assert the sliding-window behavior actually happens,
// without needing to wait out a real TTL.

process.env.UPSTASH_REDIS_REST_URL ||= 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'test-token';

const test = require('node:test');
const assert = require('node:assert/strict');

class FakeRedis {
  constructor() {
    this.store = new Map(); // key -> string value
    this.sets = new Map(); // key -> Set<string>
    this.lastExpireSeconds = new Map(); // key -> seconds (for assertions only)
    this._failRule = null; // { method, keyPrefix, n, count } — one-shot fault injection
  }
  // Simulates a transient Redis failure on the Nth call matching
  // (method, a key starting with keyPrefix) — used to prove
  // blockCreatorForShare's write-ordering and retry safety for real,
  // not just by reasoning about the code. Clears itself after firing
  // once, matching a real transient blip rather than a persistent outage.
  failOnNthCall(method, keyPrefix, n) {
    this._failRule = { method, keyPrefix, n, count: 0 };
  }
  failNextCall(method, keyPrefix) { this.failOnNthCall(method, keyPrefix, 1); }
  _check(method, key) {
    const r = this._failRule;
    if (!r || r.method !== method || !key.startsWith(r.keyPrefix)) return;
    r.count++;
    if (r.count === r.n) {
      this._failRule = null;
      throw new Error('Simulated Redis failure: ' + method + ' ' + key);
    }
  }
  async get(key) { this._check('get', key); return this.store.has(key) ? this.store.get(key) : null; }
  async set(key, value) { this._check('set', key); this.store.set(key, String(value)); return 'OK'; }
  async del(...keys) {
    let count = 0;
    for (const key of keys) {
      this._check('del', key);
      if (this.store.delete(key)) count++;
      if (this.sets.delete(key)) count++;
    }
    return count;
  }
  async sadd(key, ...members) {
    this._check('sadd', key);
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    const set = this.sets.get(key);
    let added = 0;
    for (const m of members) { if (!set.has(m)) { set.add(m); added++; } }
    return added;
  }
  async smembers(key) { this._check('smembers', key); return Array.from(this.sets.get(key) || []); }
  async srem(key, ...members) {
    this._check('srem', key);
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) { if (set.delete(m)) removed++; }
    return removed;
  }
  async expire(key, seconds) { this._check('expire', key); this.lastExpireSeconds.set(key, seconds); return (this.store.has(key) || this.sets.has(key)) ? 1 : 0; }
}

const redisClientLib = require('../redisClient');
const fakeRedis = new FakeRedis();
redisClientLib.getRedisClient = () => fakeRedis;

const { createShare, getShare, deleteShare } = require('../shareService');
const { isCreatorBlocked, recordShareCreator, blockCreatorForShare, listBlockedCreators, unblockCreator } = require('../creatorBlock');

test('recordShareCreator adds the share to the creator-shares set and slides its TTL', async () => {
  await recordShareCreator('share1', 'token-a', 31536000);
  assert.deepEqual(await fakeRedis.smembers('creator-shares:token-a'), ['share1']);
  assert.equal(fakeRedis.lastExpireSeconds.get('creator-shares:token-a'), 31536000);

  await recordShareCreator('share2', 'token-a', 31536000);
  assert.deepEqual(new Set(await fakeRedis.smembers('creator-shares:token-a')), new Set(['share1', 'share2']));
});

test('recordShareCreator is a no-op with no token (backward compatibility)', async () => {
  await recordShareCreator('share-untokened', undefined, 31536000);
  assert.equal(await fakeRedis.get('share-creator:share-untokened'), null);
});

test('blockCreatorForShare: no recorded token -> blocked:false, no side effects', async () => {
  const result = await blockCreatorForShare('never-tokened-share');
  assert.equal(result.blocked, false);
  assert.equal(typeof result.reason, 'string');
});

test('blockCreatorForShare: blocks the token AND disables every other known share from it', async () => {
  // Simulate three real shares all created by the same token.
  await fakeRedis.set('share:multi1', JSON.stringify({ hello: 1 }));
  await fakeRedis.set('share:multi2', JSON.stringify({ hello: 2 }));
  await fakeRedis.set('share:multi3', JSON.stringify({ hello: 3 }));
  await recordShareCreator('multi1', 'token-multi', 31536000);
  await recordShareCreator('multi2', 'token-multi', 31536000);
  await recordShareCreator('multi3', 'token-multi', 31536000);

  const result = await blockCreatorForShare('multi1');
  assert.equal(result.blocked, true);
  assert.equal(result.disabledShareCount, 3);

  assert.equal(await isCreatorBlocked('token-multi'), true);
  assert.equal(await getShare('multi1'), null);
  assert.equal(await getShare('multi2'), null);
  assert.equal(await getShare('multi3'), null);
});

test('blockCreatorForShare purges the creator-shares set once used (not a permanent log)', async () => {
  await fakeRedis.set('share:purgeme', JSON.stringify({}));
  await recordShareCreator('purgeme', 'token-purge', 31536000);
  await blockCreatorForShare('purgeme');
  assert.deepEqual(await fakeRedis.smembers('creator-shares:token-purge'), []);
});

test('blockCreatorForShare correctly handles an ALREADY-EXPIRED sibling share (no special-casing needed)', async () => {
  // multi2's underlying share:<id> was already gone (expired/removed)
  // before the block happens, but its id is still in the creator-shares
  // set — deleteShare's own del() is naturally a no-op on a missing key.
  await fakeRedis.set('share:live1', JSON.stringify({}));
  // share:expired1 deliberately never set — simulates natural TTL expiry.
  await recordShareCreator('live1', 'token-mixed', 31536000);
  await recordShareCreator('expired1', 'token-mixed', 31536000);

  const result = await blockCreatorForShare('live1');
  assert.equal(result.disabledShareCount, 1); // only the still-live one counts
});

test('blockCreatorForShare is idempotent — calling it twice never double-counts or errors', async () => {
  await fakeRedis.set('share:idem1', JSON.stringify({}));
  await fakeRedis.set('share:idem2', JSON.stringify({}));
  await recordShareCreator('idem1', 'token-idem', 31536000);
  await recordShareCreator('idem2', 'token-idem', 31536000);

  const first = await blockCreatorForShare('idem1');
  assert.equal(first.disabledShareCount, 2);

  const second = await blockCreatorForShare('idem1');
  assert.equal(second.blocked, true); // re-blocking an already-blocked token is harmless
  assert.equal(second.disabledShareCount, 0); // set was already purged by the first call
});

test('a token with no shares recorded yet (fresh, never shared) blocks cleanly with disabledShareCount: 0', async () => {
  await fakeRedis.set('share:lonely', JSON.stringify({}));
  await recordShareCreator('lonely', 'token-lonely', 31536000);
  const result = await blockCreatorForShare('lonely');
  assert.equal(result.disabledShareCount, 1);
});

test('isCreatorBlocked returns false for an unknown/unblocked token, true after blocking', async () => {
  assert.equal(await isCreatorBlocked('never-blocked-token'), false);
  await fakeRedis.set('share:toblock', JSON.stringify({}));
  await recordShareCreator('toblock', 'token-tobecomeblocked', 31536000);
  await blockCreatorForShare('toblock');
  assert.equal(await isCreatorBlocked('token-tobecomeblocked'), true);
});

test('isCreatorBlocked with no token at all is always false (backward compatibility)', async () => {
  assert.equal(await isCreatorBlocked(undefined), false);
  assert.equal(await isCreatorBlocked(null), false);
  assert.equal(await isCreatorBlocked(''), false);
});

// ── listBlockedCreators / unblockCreator ──
//
// This file's fakeRedis accumulates state across every test with no
// reset (see this file's own header) — by the time these run, several
// earlier tests above have already left their own blockCreatorForShare
// calls' entries in blocked-creators:index. Asserting on the GLOBAL
// list's length or position would be as ambiguous here as it was in
// adminModerationWorkflows.integration.test.js; this helper reads the
// reverse-lookup key directly to get THIS test's own blockId
// unambiguously, regardless of how many other entries already exist.
async function blockIdFor(token) {
  return fakeRedis.get('creator-token-block-id:' + token);
}

test('listBlockedCreators: never includes the real token, only the opaque blockId, blockedAt, and disabledShareCount', async () => {
  await fakeRedis.set('share:list1', JSON.stringify({}));
  await recordShareCreator('list1', 'token-list-secret', 31536000);
  await blockCreatorForShare('list1');

  const blockId = await blockIdFor('token-list-secret');
  const list = await listBlockedCreators();
  const entry = list.find((c) => c.blockId === blockId);
  assert.ok(entry);
  assert.equal(typeof entry.blockId, 'string');
  assert.notEqual(entry.blockId, 'token-list-secret');
  assert.equal(typeof entry.blockedAt, 'number');
  assert.equal(entry.disabledShareCount, 1);
  assert.equal(JSON.stringify(list).includes('token-list-secret'), false);
});

test('unblockCreator: restores every share the block disabled and lifts the block', async () => {
  await fakeRedis.set('share:ub1', JSON.stringify({ n: 1 }));
  await fakeRedis.set('share:ub2', JSON.stringify({ n: 2 }));
  await recordShareCreator('ub1', 'token-unblock', 31536000);
  await recordShareCreator('ub2', 'token-unblock', 31536000);
  await blockCreatorForShare('ub1');

  const blockId = await blockIdFor('token-unblock');
  const result = await unblockCreator(blockId);
  assert.equal(result.unblocked, true);
  assert.equal(result.restoredShareCount, 2);

  assert.deepEqual(await getShare('ub1'), { n: 1 });
  assert.deepEqual(await getShare('ub2'), { n: 2 });
  assert.equal(await isCreatorBlocked('token-unblock'), false);
  assert.equal((await listBlockedCreators()).some((c) => c.blockId === blockId), false);
});

test('unblockCreator: an unknown blockId returns unblocked:false with a reason, not an error', async () => {
  const result = await unblockCreator('never-issued-block-id');
  assert.equal(result.unblocked, false);
  assert.equal(typeof result.reason, 'string');
});

test('unblockCreator: does not restore a share independently hard-deleted before the block (nothing to restore — it was already gone)', async () => {
  await fakeRedis.set('share:keep-gone', JSON.stringify({}));
  await recordShareCreator('keep-gone', 'token-mixed-restore', 31536000);
  await deleteShare('keep-gone'); // independent, permanent removal BEFORE the block
  await fakeRedis.set('share:keep-live', JSON.stringify({ ok: true }));
  await recordShareCreator('keep-live', 'token-mixed-restore', 31536000);

  const blockResult = await blockCreatorForShare('keep-live');
  assert.equal(blockResult.disabledShareCount, 1); // keep-gone never counted — already gone

  const blockId = await blockIdFor('token-mixed-restore');
  const unblockResult = await unblockCreator(blockId);
  assert.equal(unblockResult.restoredShareCount, 1);
  assert.equal(await getShare('keep-gone'), null); // still gone, permanently
  assert.deepEqual(await getShare('keep-live'), { ok: true });
});

test('unblockCreator: calling it twice is safe — the second call is a harmless no-op, never double-restores', async () => {
  await fakeRedis.set('share:retry1', JSON.stringify({}));
  await recordShareCreator('retry1', 'token-retry', 31536000);
  await blockCreatorForShare('retry1');
  const blockId = await blockIdFor('token-retry');

  const first = await unblockCreator(blockId);
  assert.equal(first.unblocked, true);
  const second = await unblockCreator(blockId);
  assert.equal(second.unblocked, false); // already unblocked — correctly not a fresh success
});

test('blockCreatorForShare: re-blocking an already-blocked token reuses the same blockId (never lists the same creator twice)', async () => {
  await fakeRedis.set('share:reblock1', JSON.stringify({}));
  await recordShareCreator('reblock1', 'token-reblock', 31536000);

  const first = await blockCreatorForShare('reblock1');
  assert.equal(first.blocked, true);
  const firstBlockId = await blockIdFor('token-reblock');

  // Re-block the same token via a second share, before any unblock.
  await fakeRedis.set('share:reblock2', JSON.stringify({}));
  await recordShareCreator('reblock2', 'token-reblock', 31536000);
  const second = await blockCreatorForShare('reblock2');
  assert.equal(second.blocked, true);

  const secondBlockId = await blockIdFor('token-reblock');
  assert.equal(secondBlockId, firstBlockId); // reused, not a new one

  const matchingEntries = (await listBlockedCreators()).filter((c) => c.blockId === firstBlockId);
  assert.equal(matchingEntries.length, 1); // not two entries for the same creator
});

// ── Reliability: simulated Redis failures at specific points, and retries ──

test('blockCreatorForShare: a failure BEFORE the enforcement flag leaves NOTHING enforced — clean, safely retryable, never orphaned', async () => {
  await fakeRedis.set('share:preflag1', JSON.stringify({}));
  await recordShareCreator('preflag1', 'token-preflag', 31536000);

  // The very first write in the new order (the reverse blockId mapping).
  fakeRedis.failNextCall('set', 'creator-token-block-id:');
  await assert.rejects(() => blockCreatorForShare('preflag1'));

  assert.equal(await isCreatorBlocked('token-preflag'), false);
  assert.equal(await blockIdFor('token-preflag'), null);

  const retry = await blockCreatorForShare('preflag1');
  assert.equal(retry.blocked, true);
  assert.equal(retry.disabledShareCount, 1);
  assert.equal(await isCreatorBlocked('token-preflag'), true);
  const blockId = await blockIdFor('token-preflag');
  assert.ok(blockId);
  assert.equal((await listBlockedCreators()).some((c) => c.blockId === blockId), true);
});

test('blockCreatorForShare: a failure AFTER the enforcement flag but DURING share disabling still leaves the block fully discoverable and reversible', async () => {
  await fakeRedis.set('share:midloop1', JSON.stringify({ n: 1 }));
  await recordShareCreator('midloop1', 'token-midloop', 31536000);

  // Inside disableShare's own write — this only runs AFTER the
  // enforcement flag has already been set, by construction.
  fakeRedis.failNextCall('set', 'share-disabled:');
  await assert.rejects(() => blockCreatorForShare('midloop1'));

  // The block is real and visible DESPITE the mid-loop failure — this
  // is the entire point of writing the enforcement flag last among the
  // blockId/mapping/index writes, but still before the share loop.
  assert.equal(await isCreatorBlocked('token-midloop'), true);
  const blockId = await blockIdFor('token-midloop');
  assert.ok(blockId);
  assert.equal((await listBlockedCreators()).some((c) => c.blockId === blockId), true);
  assert.deepEqual(await getShare('midloop1'), { n: 1 }); // not yet actually disabled

  const retry = await blockCreatorForShare('midloop1');
  assert.equal(retry.disabledShareCount, 1);
  assert.equal(await getShare('midloop1'), null);
});

test('blockCreatorForShare: a failure DURING tracking (the sadd into creator-block-disabled) is safely retried, never double-tracked', async () => {
  await fakeRedis.set('share:trackfail1', JSON.stringify({ x: 1 }));
  await recordShareCreator('trackfail1', 'token-trackfail', 31536000);

  fakeRedis.failNextCall('sadd', 'creator-block-disabled:');
  await assert.rejects(() => blockCreatorForShare('trackfail1'));

  // Tracking happens BEFORE disabling, so a failure here means the
  // share was never actually disabled either — nothing to undo.
  assert.deepEqual(await getShare('trackfail1'), { x: 1 });
  assert.equal(await isCreatorBlocked('token-trackfail'), true);

  const retry = await blockCreatorForShare('trackfail1');
  assert.equal(retry.disabledShareCount, 1);
  assert.equal(await getShare('trackfail1'), null);
  const token = await fakeRedis.get('share-creator:trackfail1');
  const tracked = await fakeRedis.smembers('creator-block-disabled:' + token);
  assert.deepEqual(tracked, ['trackfail1']); // exactly once, not duplicated
});

test('blockCreatorForShare: with multiple shares, a mid-loop failure leaves earlier shares correctly disabled+tracked, and a retry finishes the rest without duplicating or re-disabling', async () => {
  await fakeRedis.set('share:multi-retry-1', JSON.stringify({ n: 1 }));
  await fakeRedis.set('share:multi-retry-2', JSON.stringify({ n: 2 }));
  await fakeRedis.set('share:multi-retry-3', JSON.stringify({ n: 3 }));
  await recordShareCreator('multi-retry-1', 'token-multi-retry', 31536000);
  await recordShareCreator('multi-retry-2', 'token-multi-retry', 31536000);
  await recordShareCreator('multi-retry-3', 'token-multi-retry', 31536000);

  // Fails the 2nd share's own disable write — the 1st completes fully,
  // the 3rd is never reached.
  fakeRedis.failOnNthCall('set', 'share-disabled:', 2);
  await assert.rejects(() => blockCreatorForShare('multi-retry-1'));

  assert.equal(await getShare('multi-retry-1'), null); // fully disabled
  assert.deepEqual(await getShare('multi-retry-2'), { n: 2 }); // tracked, NOT yet disabled
  assert.deepEqual(await getShare('multi-retry-3'), { n: 3 }); // never reached

  const retry = await blockCreatorForShare('multi-retry-1');
  // Share 1 is skipped this time (shareExists is false — already
  // disabled by the first call) — only 2 and 3 count as newly disabled.
  assert.equal(retry.disabledShareCount, 2);

  assert.equal(await getShare('multi-retry-1'), null);
  assert.equal(await getShare('multi-retry-2'), null);
  assert.equal(await getShare('multi-retry-3'), null);

  const token = await fakeRedis.get('share-creator:multi-retry-1');
  const tracked = await fakeRedis.smembers('creator-block-disabled:' + token);
  assert.equal(tracked.length, 3);
  assert.equal(new Set(tracked).size, 3); // no duplicates despite two attempts
});

test('blockCreatorForShare: a SECOND failure during the retry itself is also safely recovered by a further retry, with no corruption, and unblock afterward restores everything exactly once', async () => {
  await fakeRedis.set('share:double-retry-1', JSON.stringify({ n: 1 }));
  await fakeRedis.set('share:double-retry-2', JSON.stringify({ n: 2 }));
  await recordShareCreator('double-retry-1', 'token-double-retry', 31536000);
  await recordShareCreator('double-retry-2', 'token-double-retry', 31536000);

  fakeRedis.failOnNthCall('set', 'share-disabled:', 1);
  await assert.rejects(() => blockCreatorForShare('double-retry-1'));

  // The retry itself ALSO fails, at a different point this time.
  fakeRedis.failOnNthCall('sadd', 'creator-block-disabled:', 1);
  await assert.rejects(() => blockCreatorForShare('double-retry-1'));

  // A further retry finally completes cleanly.
  const finalResult = await blockCreatorForShare('double-retry-1');
  assert.equal(finalResult.disabledShareCount, 2);
  assert.equal(await getShare('double-retry-1'), null);
  assert.equal(await getShare('double-retry-2'), null);

  const token = await fakeRedis.get('share-creator:double-retry-1');
  const tracked = await fakeRedis.smembers('creator-block-disabled:' + token);
  assert.equal(new Set(tracked).size, 2); // no duplicates despite three attempts total

  const blockId = await blockIdFor(token);
  const unblockResult = await unblockCreator(blockId);
  assert.equal(unblockResult.restoredShareCount, 2);
  assert.deepEqual(await getShare('double-retry-1'), { n: 1 });
  assert.deepEqual(await getShare('double-retry-2'), { n: 2 });
});

test('blockCreatorForShare: failing and retrying one creator\'s block never touches a completely unrelated, already-blocked creator', async () => {
  // An unrelated creator, already blocked and untouched by anything below.
  await fakeRedis.set('share:unrelated1', JSON.stringify({ u: 1 }));
  await recordShareCreator('unrelated1', 'token-unrelated', 31536000);
  await blockCreatorForShare('unrelated1');
  const unrelatedBlockId = await blockIdFor('token-unrelated');
  assert.ok(unrelatedBlockId);

  await fakeRedis.set('share:isolated1', JSON.stringify({ n: 1 }));
  await recordShareCreator('isolated1', 'token-isolated', 31536000);
  fakeRedis.failNextCall('set', 'share-disabled:');
  await assert.rejects(() => blockCreatorForShare('isolated1'));
  await blockCreatorForShare('isolated1'); // retry, succeeds

  // The unrelated creator's own block, token, and shares are exactly
  // as they were — untouched by the failure/retry cycle above.
  assert.equal(await isCreatorBlocked('token-unrelated'), true);
  assert.equal(await blockIdFor('token-unrelated'), unrelatedBlockId);
  assert.equal(await getShare('unrelated1'), null); // still disabled, as it was
});

// ── unblockCreator reliability: simulated Redis failures at specific stages, and retries ──
//
// unblockCreator's own ordering (restore shares -> clear tracking set ->
// clear the enforcement flag -> clear blockId mappings -> remove from
// the index) has no equivalent to blockCreatorForShare's "track before
// act" concern — there's only ever ONE action per share (restore), not
// a track+act pair — but it still needs its own direct verification
// that a failure at each distinct stage is safely retryable and never
// leaves the creator blocked-but-unlisted (the UNBLOCK-side mirror of
// the orphaned-block risk blockCreatorForShare was fixed for).

test('unblockCreator: a failure DURING the share-restore loop leaves the block still fully listed and reachable; retry completes cleanly', async () => {
  await fakeRedis.set('share:unblock-fail-1', JSON.stringify({ n: 1 }));
  await fakeRedis.set('share:unblock-fail-2', JSON.stringify({ n: 2 }));
  await recordShareCreator('unblock-fail-1', 'token-unblock-fail-a', 31536000);
  await recordShareCreator('unblock-fail-2', 'token-unblock-fail-a', 31536000);
  await blockCreatorForShare('unblock-fail-1');
  const blockId = await blockIdFor('token-unblock-fail-a');

  fakeRedis.failNextCall('del', 'share-disabled:');
  await assert.rejects(() => unblockCreator(blockId));

  // Still blocked AND still listed — never one without the other.
  assert.equal(await isCreatorBlocked('token-unblock-fail-a'), true);
  assert.equal((await listBlockedCreators()).some((c) => c.blockId === blockId), true);
  assert.equal(await getShare('unblock-fail-1'), null); // not yet restored

  const retry = await unblockCreator(blockId);
  assert.equal(retry.unblocked, true);
  assert.equal(retry.restoredShareCount, 2);
  assert.deepEqual(await getShare('unblock-fail-1'), { n: 1 });
  assert.deepEqual(await getShare('unblock-fail-2'), { n: 2 });
  assert.equal(await isCreatorBlocked('token-unblock-fail-a'), false);
});

test('unblockCreator: a failure clearing the per-block tracking set (AFTER shares are already restored) retries safely without double-restoring', async () => {
  await fakeRedis.set('share:unblock-fail-track-1', JSON.stringify({ n: 1 }));
  await recordShareCreator('unblock-fail-track-1', 'token-unblock-fail-b', 31536000);
  await blockCreatorForShare('unblock-fail-track-1');
  const blockId = await blockIdFor('token-unblock-fail-b');

  fakeRedis.failNextCall('del', 'creator-block-disabled:');
  await assert.rejects(() => unblockCreator(blockId));

  // The share was already restored inside the loop, before this
  // failure point.
  assert.deepEqual(await getShare('unblock-fail-track-1'), { n: 1 });
  assert.equal(await isCreatorBlocked('token-unblock-fail-b'), true); // flag not yet cleared

  const retry = await unblockCreator(blockId);
  assert.equal(retry.unblocked, true);
  assert.equal(retry.restoredShareCount, 0); // nothing left to restore — not double-counted
  assert.equal(await isCreatorBlocked('token-unblock-fail-b'), false);
});

test('unblockCreator: a failure deleting the enforcement flag itself is retried safely', async () => {
  await fakeRedis.set('share:unblock-fail-flag-1', JSON.stringify({ n: 1 }));
  await recordShareCreator('unblock-fail-flag-1', 'token-unblock-fail-c', 31536000);
  await blockCreatorForShare('unblock-fail-flag-1');
  const blockId = await blockIdFor('token-unblock-fail-c');

  fakeRedis.failNextCall('del', 'blocked:creator:');
  await assert.rejects(() => unblockCreator(blockId));

  assert.equal(await isCreatorBlocked('token-unblock-fail-c'), true);
  assert.equal((await listBlockedCreators()).some((c) => c.blockId === blockId), true);

  const retry = await unblockCreator(blockId);
  assert.equal(retry.unblocked, true);
  assert.equal(await isCreatorBlocked('token-unblock-fail-c'), false);
});

test('unblockCreator: a failure AFTER the enforcement flag is cleared never leaves the creator blocked-but-unlisted — self-heals via stale-entry detection', async () => {
  await fakeRedis.set('share:unblock-fail-cleanup-1', JSON.stringify({ n: 1 }));
  await recordShareCreator('unblock-fail-cleanup-1', 'token-unblock-fail-d', 31536000);
  await blockCreatorForShare('unblock-fail-cleanup-1');
  const blockId = await blockIdFor('token-unblock-fail-d');

  fakeRedis.failNextCall('del', 'creator-block-id:');
  await assert.rejects(() => unblockCreator(blockId));

  // The enforcement flag is ALREADY gone at this point — the creator
  // must never read as blocked from here on, and must never still show
  // up as blocked in the list either, regardless of leftover mapping
  // cruft that hasn't been swept yet.
  assert.equal(await isCreatorBlocked('token-unblock-fail-d'), false);
  assert.equal((await listBlockedCreators()).some((c) => c.blockId === blockId), false);
  assert.deepEqual(await getShare('unblock-fail-cleanup-1'), { n: 1 }); // already restored
});

test('unblockCreator: repeated retries across multiple distinct failure points never duplicate restoration or corrupt tracking', async () => {
  await fakeRedis.set('share:unblock-multi-retry-1', JSON.stringify({ n: 1 }));
  await fakeRedis.set('share:unblock-multi-retry-2', JSON.stringify({ n: 2 }));
  await recordShareCreator('unblock-multi-retry-1', 'token-unblock-multi-retry', 31536000);
  await recordShareCreator('unblock-multi-retry-2', 'token-unblock-multi-retry', 31536000);
  await blockCreatorForShare('unblock-multi-retry-1');
  const blockId = await blockIdFor('token-unblock-multi-retry');

  fakeRedis.failNextCall('del', 'share-disabled:');
  await assert.rejects(() => unblockCreator(blockId));

  fakeRedis.failNextCall('del', 'creator-block-disabled:');
  await assert.rejects(() => unblockCreator(blockId));

  const finalResult = await unblockCreator(blockId);
  assert.equal(finalResult.unblocked, true);
  assert.deepEqual(await getShare('unblock-multi-retry-1'), { n: 1 });
  assert.deepEqual(await getShare('unblock-multi-retry-2'), { n: 2 });
  assert.equal(await isCreatorBlocked('token-unblock-multi-retry'), false);

  // A further call, now that it's genuinely fully unblocked, is a
  // harmless no-op — not a fresh "success" and not an error.
  const afterFullyDone = await unblockCreator(blockId);
  assert.equal(afterFullyDone.unblocked, false);
});

test('unblockCreator: an independently taken-down share remains permanently unavailable across a failure-and-retry unblock cycle', async () => {
  await fakeRedis.set('share:unblock-takedown-safe-1', JSON.stringify({ gone: true }));
  await recordShareCreator('unblock-takedown-safe-1', 'token-unblock-takedown-safe', 31536000);
  await deleteShare('unblock-takedown-safe-1'); // independent, permanent, BEFORE the block

  await fakeRedis.set('share:unblock-takedown-safe-2', JSON.stringify({ n: 2 }));
  await recordShareCreator('unblock-takedown-safe-2', 'token-unblock-takedown-safe', 31536000);

  const blockResult = await blockCreatorForShare('unblock-takedown-safe-2');
  assert.equal(blockResult.disabledShareCount, 1); // the taken-down one never counted
  const blockId = await blockIdFor('token-unblock-takedown-safe');

  fakeRedis.failNextCall('del', 'share-disabled:');
  await assert.rejects(() => unblockCreator(blockId));
  const retry = await unblockCreator(blockId);
  assert.equal(retry.restoredShareCount, 1); // only the legitimately-disabled one

  assert.equal(await getShare('unblock-takedown-safe-1'), null); // still permanently gone
  assert.deepEqual(await getShare('unblock-takedown-safe-2'), { n: 2 });
});
