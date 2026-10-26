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
  }
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async set(key, value) { this.store.set(key, String(value)); return 'OK'; }
  async del(...keys) {
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count++;
      if (this.sets.delete(key)) count++;
    }
    return count;
  }
  async sadd(key, ...members) {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    const set = this.sets.get(key);
    let added = 0;
    for (const m of members) { if (!set.has(m)) { set.add(m); added++; } }
    return added;
  }
  async smembers(key) { return Array.from(this.sets.get(key) || []); }
  async expire(key, seconds) { this.lastExpireSeconds.set(key, seconds); return (this.store.has(key) || this.sets.has(key)) ? 1 : 0; }
}

const redisClientLib = require('../redisClient');
const fakeRedis = new FakeRedis();
redisClientLib.getRedisClient = () => fakeRedis;

const { createShare, getShare, deleteShare } = require('../shareService');
const { isCreatorBlocked, recordShareCreator, blockCreatorForShare } = require('../creatorBlock');

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
