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
    this.hashes = new Map(); // key -> Map<field, string value>
    this.lastExpireSeconds = new Map(); // key -> seconds (for assertions only)
    // Real TTL-establishing calls — BOTH set(key, value, {ex}) and
    // expire(key, seconds) — tracked by call COUNT per key, not just the
    // last value, specifically so a test can prove a key's TTL was
    // actually renewed AGAIN on a particular later call (count went up),
    // not merely that it still holds whatever value an earlier call left
    // behind. This is what makes it possible to inspect real Redis TTL
    // behavior directly, rather than only inferring it from this
    // function's logical return values.
    this.ttlRefreshCount = new Map();
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
  async set(key, value, opts) {
    this._check('set', key);
    this.store.set(key, String(value));
    if (opts && typeof opts.ex === 'number') {
      this.ttlRefreshCount.set(key, (this.ttlRefreshCount.get(key) || 0) + 1);
    }
    return 'OK';
  }
  async del(...keys) {
    let count = 0;
    for (const key of keys) {
      this._check('del', key);
      if (this.store.delete(key)) count++;
      if (this.sets.delete(key)) count++;
      if (this.hashes.delete(key)) count++;
    }
    return count;
  }
  async hset(key, fields) {
    this._check('hset', key);
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    const h = this.hashes.get(key);
    let added = 0;
    for (const [field, value] of Object.entries(fields)) {
      if (!h.has(field)) added++;
      h.set(field, String(value));
    }
    return added;
  }
  async hgetall(key) {
    this._check('hgetall', key);
    const h = this.hashes.get(key);
    if (!h) return null;
    return Object.fromEntries(h);
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
  async expire(key, seconds) {
    this._check('expire', key);
    this.lastExpireSeconds.set(key, seconds);
    this.ttlRefreshCount.set(key, (this.ttlRefreshCount.get(key) || 0) + 1);
    return (this.store.has(key) || this.sets.has(key) || this.hashes.has(key)) ? 1 : 0;
  }
}

const redisClientLib = require('../redisClient');
const fakeRedis = new FakeRedis();
redisClientLib.getRedisClient = () => fakeRedis;

const { createShare, getShare, deleteShare } = require('../shareService');
const { isCreatorBlocked, recordShareCreator, blockCreatorForShare, listBlockedCreators, unblockCreator, getTriggerContent } = require('../creatorBlock');

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

// ── Blocking trigger snapshot (creator-block-triggers:<token>) ──

function trigger(overrides) {
  return Object.assign({ reportId: 'rp-' + Math.random().toString(16).slice(2), shareId: 's', reason: 'spam', details: '', createdAt: 1700000000000 }, overrides);
}

test('blockCreatorForShare: a trigger snapshots all five fields and is surfaced by listBlockedCreators', async () => {
  await fakeRedis.set('share:trig1', JSON.stringify({}));
  await recordShareCreator('trig1', 'token-trig-single', 31536000);
  await blockCreatorForShare('trig1', trigger({ reportId: 'rp-single', shareId: 'trig1', reason: 'hate_speech', details: 'contains a slur', createdAt: 1234567 }));

  const blockId = await blockIdFor('token-trig-single');
  const entry = (await listBlockedCreators()).find((c) => c.blockId === blockId);
  assert.deepEqual(entry.triggers, [{ reportId: 'rp-single', shareId: 'trig1', reason: 'hate_speech', details: 'contains a slur', createdAt: 1234567 }]);
  assert.deepEqual(entry.reasons, ['hate_speech']);
});

test('blockCreatorForShare: multiple contributing reports produce multiple, independently identifiable trigger records', async () => {
  await fakeRedis.set('share:trig-multi1', JSON.stringify({}));
  await recordShareCreator('trig-multi1', 'token-trig-multi', 31536000);
  await blockCreatorForShare('trig-multi1', trigger({ reportId: 'rp-a', shareId: 'trig-multi1', reason: 'spam' }));

  // A second report, on a DIFFERENT share from the same already-blocked
  // token — simulates re-blocking (idempotent) triggered by a second
  // report.
  await fakeRedis.set('share:trig-multi2', JSON.stringify({}));
  await recordShareCreator('trig-multi2', 'token-trig-multi', 31536000);
  await blockCreatorForShare('trig-multi2', trigger({ reportId: 'rp-b', shareId: 'trig-multi2', reason: 'harassment' }));

  const blockId = await blockIdFor('token-trig-multi');
  const entry = (await listBlockedCreators()).find((c) => c.blockId === blockId);
  assert.equal(entry.triggers.length, 2);
  const byReportId = Object.fromEntries(entry.triggers.map((t) => [t.reportId, t]));
  assert.equal(byReportId['rp-a'].shareId, 'trig-multi1');
  assert.equal(byReportId['rp-b'].shareId, 'trig-multi2');
  assert.deepEqual(new Set(entry.reasons), new Set(['spam', 'harassment']));
});

test('blockCreatorForShare: a repeated/retried call for the SAME reportId never creates a duplicate trigger record', async () => {
  await fakeRedis.set('share:trig-dup1', JSON.stringify({}));
  await recordShareCreator('trig-dup1', 'token-trig-dup', 31536000);
  const t = trigger({ reportId: 'rp-dup', shareId: 'trig-dup1', reason: 'spam', details: 'same report, called twice' });

  await blockCreatorForShare('trig-dup1', t);
  // Idempotent re-block for the SAME report (e.g. a retried admin action)
  // — content is identical since the source report is immutable.
  await blockCreatorForShare('trig-dup1', t);

  const blockId = await blockIdFor('token-trig-dup');
  const entry = (await listBlockedCreators()).find((c) => c.blockId === blockId);
  assert.equal(entry.triggers.length, 1);
  assert.deepEqual(entry.triggers[0], t);
});

test('blockCreatorForShare: a malformed trigger (invalid reason, or missing reportId/shareId) is silently dropped, never persisted', async () => {
  await fakeRedis.set('share:trig-invalid', JSON.stringify({}));
  await recordShareCreator('trig-invalid', 'token-trig-invalid', 31536000);
  const result = await blockCreatorForShare('trig-invalid', trigger({ reason: 'not-a-real-reason' }));
  assert.equal(result.blocked, true); // the block itself still proceeds normally

  const blockId = await blockIdFor('token-trig-invalid');
  const entry = (await listBlockedCreators()).find((c) => c.blockId === blockId);
  assert.deepEqual(entry.triggers, []);
  assert.deepEqual(entry.reasons, []);
});

test('blockCreatorForShare: no trigger supplied (legacy block, or the Bearer-token path with no associated report) honestly reports none recorded', async () => {
  await fakeRedis.set('share:trig-none', JSON.stringify({}));
  await recordShareCreator('trig-none', 'token-trig-none', 31536000);
  await blockCreatorForShare('trig-none'); // no second argument at all — same call shape every pre-existing caller already uses

  const blockId = await blockIdFor('token-trig-none');
  const entry = (await listBlockedCreators()).find((c) => c.blockId === blockId);
  assert.deepEqual(entry.triggers, []);
  assert.deepEqual(entry.reasons, []);
});

test('blockCreatorForShare: the trigger snapshot is independent of the original report — still intact even if that report record is gone', async () => {
  // Nothing in this test ever creates a report:<reportId> record at all —
  // simulating a report whose own record has already expired/vanished by
  // the time anyone looks at the block again. The trigger snapshot must
  // not depend on it existing.
  await fakeRedis.set('share:trig-survives1', JSON.stringify({}));
  await recordShareCreator('trig-survives1', 'token-trig-survives', 31536000);
  await blockCreatorForShare('trig-survives1', trigger({ reportId: 'rp-survives', shareId: 'trig-survives1', reason: 'other', details: 'original report record never existed in this fake store' }));

  const blockId = await blockIdFor('token-trig-survives');
  const entry = (await listBlockedCreators()).find((c) => c.blockId === blockId);
  assert.equal(entry.triggers.length, 1);
  assert.equal(entry.triggers[0].details, 'original report record never existed in this fake store');
});

test('unblockCreator: clears the recorded trigger records along with the rest of the block state', async () => {
  await fakeRedis.set('share:trig-unblock', JSON.stringify({}));
  await recordShareCreator('trig-unblock', 'token-trig-unblock', 31536000);
  await blockCreatorForShare('trig-unblock', trigger({ reportId: 'rp-unblock', shareId: 'trig-unblock', reason: 'sexual_content' }));
  const blockId = await blockIdFor('token-trig-unblock');

  await unblockCreator(blockId);
  assert.equal(await fakeRedis.hgetall('creator-block-triggers:token-trig-unblock'), null);
});

test('blockCreatorForShare: re-blocking the SAME token after a full unblock starts with clean trigger state — no bleed-through from the reversed block', async () => {
  await fakeRedis.set('share:trig-reblock1', JSON.stringify({}));
  await recordShareCreator('trig-reblock1', 'token-trig-reblock', 31536000);
  await blockCreatorForShare('trig-reblock1', trigger({ reportId: 'rp-reblock-old', shareId: 'trig-reblock1', reason: 'hate_speech' }));
  const firstBlockId = await blockIdFor('token-trig-reblock');
  await unblockCreator(firstBlockId);

  // Re-block the same token, from an unrelated later report — the old,
  // already-reversed trigger must not resurface here.
  await fakeRedis.set('share:trig-reblock2', JSON.stringify({}));
  await recordShareCreator('trig-reblock2', 'token-trig-reblock', 31536000);
  await blockCreatorForShare('trig-reblock2', trigger({ reportId: 'rp-reblock-new', shareId: 'trig-reblock2', reason: 'other' }));

  const secondBlockId = await blockIdFor('token-trig-reblock');
  const entry = (await listBlockedCreators()).find((c) => c.blockId === secondBlockId);
  assert.equal(entry.triggers.length, 1);
  assert.equal(entry.triggers[0].reportId, 'rp-reblock-new');
});

// ── TTL renewal invariant: the triggers hash must be refreshed to the
//    SAME retention horizon as the block itself, on EVERY call that
//    renews the block — not only on a call that happens to carry a new
//    valid trigger. Inspects the FakeRedis's actual TTL-establishing
//    calls directly (ttlRefreshCount / lastExpireSeconds), not just this
//    function's logical return values. ──

test('blockCreatorForShare: re-blocking an already-blocked token WITHOUT a new trigger still refreshes the triggers hash\'s TTL to the same horizon as the block itself', async () => {
  await fakeRedis.set('share:ttl-noNewTrigger1', JSON.stringify({}));
  await recordShareCreator('ttl-noNewTrigger1', 'token-ttl-no-new', 31536000);
  await blockCreatorForShare('ttl-noNewTrigger1', trigger({ reportId: 'rp-ttl-no-new', shareId: 'ttl-noNewTrigger1', reason: 'spam' }));

  const token = 'token-ttl-no-new';
  const enforcementKey = 'blocked:creator:' + token;
  const triggersKey = 'creator-block-triggers:' + token;

  const enforcementCountBefore = fakeRedis.ttlRefreshCount.get(enforcementKey) || 0;
  const triggersCountBefore = fakeRedis.ttlRefreshCount.get(triggersKey) || 0;
  assert.ok(enforcementCountBefore >= 1);
  assert.ok(triggersCountBefore >= 1);

  // Re-block the SAME token via a second, unrelated share, with NO
  // trigger argument at all this time — simulates the Bearer-token
  // api/admin/block-creator.js path, or an admin-ui re-block with no
  // reportId.
  await fakeRedis.set('share:ttl-noNewTrigger2', JSON.stringify({}));
  await recordShareCreator('ttl-noNewTrigger2', token, 31536000);
  const result = await blockCreatorForShare('ttl-noNewTrigger2');
  assert.equal(result.blocked, true);

  // Both the enforcement flag's TTL AND the triggers hash's TTL were
  // renewed AGAIN, in THIS SAME call — not merely still holding whatever
  // value the original block call left behind.
  assert.equal(fakeRedis.ttlRefreshCount.get(enforcementKey), enforcementCountBefore + 1);
  assert.equal(fakeRedis.ttlRefreshCount.get(triggersKey), triggersCountBefore + 1);

  // And the actual TTL value applied is the real BLOCK_TTL_SECONDS
  // horizon, matching the enforcement flag's own.
  assert.equal(fakeRedis.lastExpireSeconds.get(triggersKey), 31536000);

  // The previously-recorded trigger is still fully intact, unchanged —
  // this call didn't need a new trigger to keep the old one alive.
  const blockId = await blockIdFor(token);
  const entry = (await listBlockedCreators()).find((c) => c.blockId === blockId);
  assert.equal(entry.triggers.length, 1);
  assert.equal(entry.triggers[0].reportId, 'rp-ttl-no-new');
});

test('blockCreatorForShare: repeated no-new-trigger re-blocks keep refreshing the triggers hash every time — it can never fall behind the block\'s own renewed horizon', async () => {
  await fakeRedis.set('share:ttl-repeat1', JSON.stringify({}));
  await recordShareCreator('ttl-repeat1', 'token-ttl-repeat', 31536000);
  await blockCreatorForShare('ttl-repeat1', trigger({ reportId: 'rp-ttl-repeat', shareId: 'ttl-repeat1', reason: 'spam' }));

  const triggersKey = 'creator-block-triggers:token-ttl-repeat';
  const countAfterFirst = fakeRedis.ttlRefreshCount.get(triggersKey);

  // Three more no-trigger re-blocks in a row (e.g. three separate,
  // unrelated admin actions against the same already-blocked creator).
  for (let i = 0; i < 3; i++) {
    const shareId = 'ttl-repeat-extra-' + i;
    await fakeRedis.set('share:' + shareId, JSON.stringify({}));
    await recordShareCreator(shareId, 'token-ttl-repeat', 31536000);
    await blockCreatorForShare(shareId);
  }

  assert.equal(fakeRedis.ttlRefreshCount.get(triggersKey), countAfterFirst + 3);
});

test('blockCreatorForShare: re-blocking WITH a new trigger continues to work correctly alongside the unconditional TTL refresh (no duplicate refresh, no lost data)', async () => {
  await fakeRedis.set('share:ttl-withNew1', JSON.stringify({}));
  await recordShareCreator('ttl-withNew1', 'token-ttl-with-new', 31536000);
  await blockCreatorForShare('ttl-withNew1', trigger({ reportId: 'rp-ttl-with-new-1', shareId: 'ttl-withNew1', reason: 'spam' }));

  await fakeRedis.set('share:ttl-withNew2', JSON.stringify({}));
  await recordShareCreator('ttl-withNew2', 'token-ttl-with-new', 31536000);
  await blockCreatorForShare('ttl-withNew2', trigger({ reportId: 'rp-ttl-with-new-2', shareId: 'ttl-withNew2', reason: 'harassment' }));

  const triggersKey = 'creator-block-triggers:token-ttl-with-new';
  // Exactly one refresh per call (hset doesn't itself refresh TTL; the
  // unconditional expire() does, once per call) — not double-counted.
  assert.equal(fakeRedis.ttlRefreshCount.get(triggersKey), 2);

  const blockId = await blockIdFor('token-ttl-with-new');
  const entry = (await listBlockedCreators()).find((c) => c.blockId === blockId);
  assert.equal(entry.triggers.length, 2);
  assert.deepEqual(new Set(entry.reasons), new Set(['spam', 'harassment']));
});

test('blockCreatorForShare: a failure during the trigger snapshot write leaves nothing enforced, and a retry records the trigger correctly', async () => {
  await fakeRedis.set('share:trig-fault1', JSON.stringify({}));
  await recordShareCreator('trig-fault1', 'token-trig-fault', 31536000);

  fakeRedis.failNextCall('hset', 'creator-block-triggers:');
  await assert.rejects(() => blockCreatorForShare('trig-fault1', trigger({ reportId: 'rp-fault', shareId: 'trig-fault1', reason: 'spam' })));

  // Nothing enforced yet — same "clean, safely retryable" guarantee as
  // every other pre-enforcement-flag write in this function.
  assert.equal(await isCreatorBlocked('token-trig-fault'), false);

  const retry = await blockCreatorForShare('trig-fault1', trigger({ reportId: 'rp-fault', shareId: 'trig-fault1', reason: 'spam' }));
  assert.equal(retry.blocked, true);
  const blockId = await blockIdFor('token-trig-fault');
  const entry = (await listBlockedCreators()).find((c) => c.blockId === blockId);
  assert.equal(entry.triggers.length, 1);
  assert.equal(entry.triggers[0].reportId, 'rp-fault');
});

test('unblockCreator: a failure AFTER the triggers key is cleared but before the mapping is gone never orphans stale triggers onto a later, unrelated block of the same token', async () => {
  await fakeRedis.set('share:trig-orphan1', JSON.stringify({}));
  await recordShareCreator('trig-orphan1', 'token-trig-orphan', 31536000);
  await blockCreatorForShare('trig-orphan1', trigger({ reportId: 'rp-orphan-old', shareId: 'trig-orphan1', reason: 'spam' }));
  const blockId = await blockIdFor('token-trig-orphan');

  // Fails the very next del AFTER the triggers-key del in unblockCreator's
  // own sequence — proves the triggers key is already gone by this
  // point, not dependent on the rest of the cleanup completing.
  fakeRedis.failNextCall('del', 'blocked:creator:');
  await assert.rejects(() => unblockCreator(blockId));
  assert.equal(await fakeRedis.hgetall('creator-block-triggers:token-trig-orphan'), null);

  const retry = await unblockCreator(blockId);
  assert.equal(retry.unblocked, true);

  // Re-block the same token from a fresh report — must see ONLY the new
  // trigger, never the reversed 'rp-orphan-old' one.
  await fakeRedis.set('share:trig-orphan2', JSON.stringify({}));
  await recordShareCreator('trig-orphan2', 'token-trig-orphan', 31536000);
  await blockCreatorForShare('trig-orphan2', trigger({ reportId: 'rp-orphan-new', shareId: 'trig-orphan2', reason: 'harassment' }));
  const newBlockId = await blockIdFor('token-trig-orphan');
  const entry = (await listBlockedCreators()).find((c) => c.blockId === newBlockId);
  assert.equal(entry.triggers.length, 1);
  assert.equal(entry.triggers[0].reportId, 'rp-orphan-new');
});

test('unblockCreator: an unknown blockId never calls through to delete anything (nothing to orphan)', async () => {
  const result = await unblockCreator('never-issued-block-id-for-reasons-test');
  assert.equal(result.unblocked, false);
});

// ── getTriggerContent — the admin-only, narrowly-scoped content preview ──

test('getTriggerContent: allows a shareId that is a recorded trigger for the given blockId', async () => {
  await fakeRedis.set('share:preview-allowed', JSON.stringify({ title: 'reported content' }));
  await recordShareCreator('preview-allowed', 'token-preview-allowed', 31536000);
  await blockCreatorForShare('preview-allowed', trigger({ reportId: 'rp-preview-allowed', shareId: 'preview-allowed', reason: 'spam' }));
  const blockId = await blockIdFor('token-preview-allowed');

  const content = await getTriggerContent(blockId, 'preview-allowed');
  assert.deepEqual(content, { title: 'reported content' });
});

test('getTriggerContent: reads the content even though Block Creator disabled it (bypasses the normal disabled-is-unavailable rule, ONLY for a recorded trigger)', async () => {
  await fakeRedis.set('share:preview-disabled', JSON.stringify({ title: 'now disabled' }));
  await recordShareCreator('preview-disabled', 'token-preview-disabled', 31536000);
  await blockCreatorForShare('preview-disabled', trigger({ reportId: 'rp-preview-disabled', shareId: 'preview-disabled', reason: 'spam' }));
  const blockId = await blockIdFor('token-preview-disabled');

  // Confirm it really is disabled for the ordinary read path first.
  assert.equal(await getShare('preview-disabled'), null);
  const content = await getTriggerContent(blockId, 'preview-disabled');
  assert.deepEqual(content, { title: 'now disabled' });
});

test('getTriggerContent: refuses a share belonging to the SAME creator that is NOT a recorded trigger (merely swept/disabled, never reported)', async () => {
  await fakeRedis.set('share:sibling-reported', JSON.stringify({ title: 'reported' }));
  await fakeRedis.set('share:sibling-unreported', JSON.stringify({ title: 'never reported' }));
  await recordShareCreator('sibling-reported', 'token-sibling', 31536000);
  await recordShareCreator('sibling-unreported', 'token-sibling', 31536000);
  // Blocking sweeps and disables BOTH shares, but only one was reported.
  await blockCreatorForShare('sibling-reported', trigger({ reportId: 'rp-sibling', shareId: 'sibling-reported', reason: 'spam' }));
  const blockId = await blockIdFor('token-sibling');

  assert.deepEqual(await getTriggerContent(blockId, 'sibling-reported'), { title: 'reported' });
  assert.equal(await getTriggerContent(blockId, 'sibling-unreported'), null);
});

test('getTriggerContent: refuses an unknown blockId', async () => {
  assert.equal(await getTriggerContent('never-issued-block-id', 'anything'), null);
});

test('getTriggerContent: refuses a shareId that is a trigger for a DIFFERENT, unrelated block', async () => {
  await fakeRedis.set('share:other-block-trigger', JSON.stringify({ title: 'belongs to another creator' }));
  await recordShareCreator('other-block-trigger', 'token-other-block', 31536000);
  await blockCreatorForShare('other-block-trigger', trigger({ reportId: 'rp-other-block', shareId: 'other-block-trigger', reason: 'spam' }));

  await fakeRedis.set('share:unrelated-creator-share', JSON.stringify({}));
  await recordShareCreator('unrelated-creator-share', 'token-unrelated-creator', 31536000);
  await blockCreatorForShare('unrelated-creator-share', trigger({ reportId: 'rp-unrelated-creator', shareId: 'unrelated-creator-share', reason: 'spam' }));
  const unrelatedBlockId = await blockIdFor('token-unrelated-creator');

  // Correct shareId, but paired with the WRONG blockId.
  assert.equal(await getTriggerContent(unrelatedBlockId, 'other-block-trigger'), null);
});

test('getTriggerContent: an independently taken-down/deleted share is never resurrected merely because it was once a recorded trigger', async () => {
  await fakeRedis.set('share:trig-takedown', JSON.stringify({ title: 'will be deleted' }));
  await recordShareCreator('trig-takedown', 'token-trig-takedown', 31536000);
  await blockCreatorForShare('trig-takedown', trigger({ reportId: 'rp-trig-takedown', shareId: 'trig-takedown', reason: 'spam' }));
  const blockId = await blockIdFor('token-trig-takedown');

  // Still readable before the independent hard delete.
  assert.deepEqual(await getTriggerContent(blockId, 'trig-takedown'), { title: 'will be deleted' });

  await deleteShare('trig-takedown'); // independent, permanent — e.g. a separate Take down action
  assert.equal(await getTriggerContent(blockId, 'trig-takedown'), null);
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
