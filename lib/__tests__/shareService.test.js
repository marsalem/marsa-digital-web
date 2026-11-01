// lib/__tests__/shareService.test.js
// Run with: node --test lib/__tests__
//
// Tests the REAL shareService.js logic (not route-level mocking — see
// shareRoute.*.integration.test.js for that) against a tiny in-memory
// fake Redis, same technique as adminSession.test.js/creatorBlock.test.js
// use for their own modules. Focused specifically on disableShare/
// restoreShare/shareExists (added for Unblock Creator) and getShare's
// new disabled-marker check — createShare/getShare/deleteShare's
// pre-existing behavior is already covered incidentally via
// creatorBlock.test.js and the shareRoute integration tests.

process.env.UPSTASH_REDIS_REST_URL ||= 'https://example.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'test-token';

const test = require('node:test');
const assert = require('node:assert/strict');

class FakeRedis {
  constructor() { this.store = new Map(); }
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async set(key, value) { this.store.set(key, String(value)); return 'OK'; } // TTL (3rd arg) ignored, same as sibling fakes
  async del(...keys) {
    let count = 0;
    for (const key of keys) { if (this.store.delete(key)) count++; }
    return count;
  }
}

const redisClientLib = require('../redisClient');
const fakeRedis = new FakeRedis();
redisClientLib.getRedisClient = () => fakeRedis;

const { createShare, getShare, deleteShare, disableShare, restoreShare, shareExists } = require('../shareService');

test.beforeEach(() => { fakeRedis.store.clear(); });

// ── shareExists ──

test('shareExists: true for a live share, false for one that never existed', async () => {
  const { shareId } = await createShare({ hello: 'world' });
  assert.equal(await shareExists(shareId), true);
  assert.equal(await shareExists('never-created'), false);
});

test('shareExists: false after deleteShare (permanent)', async () => {
  const { shareId } = await createShare({ hello: 'world' });
  await deleteShare(shareId);
  assert.equal(await shareExists(shareId), false);
});

test('shareExists: false while disabled', async () => {
  const { shareId } = await createShare({ hello: 'world' });
  await disableShare(shareId, 'creator_block', 1000);
  assert.equal(await shareExists(shareId), false);
});

// ── disableShare ──

test('disableShare: a live share becomes unreadable via getShare, but its payload is NOT deleted', async () => {
  const { shareId } = await createShare({ synthetic: true });
  const disabled = await disableShare(shareId, 'creator_block', 1000);
  assert.equal(disabled, true);
  assert.equal(await getShare(shareId), null);
  // The payload key itself still exists — confirmed directly, not just
  // inferred from getShare — this is the entire point of disableShare
  // over deleteShare.
  assert.notEqual(await fakeRedis.get('share:' + shareId), null);
});

test('disableShare: a no-op (returns false) for a share that never existed', async () => {
  const disabled = await disableShare('never-created', 'creator_block', 1000);
  assert.equal(disabled, false);
});

test('disableShare: a no-op for a share that was already hard-deleted', async () => {
  const { shareId } = await createShare({ synthetic: true });
  await deleteShare(shareId);
  const disabled = await disableShare(shareId, 'creator_block', 1000);
  assert.equal(disabled, false);
});

test('disableShare: a no-op for a share that is already disabled (idempotent, does not error)', async () => {
  const { shareId } = await createShare({ synthetic: true });
  await disableShare(shareId, 'creator_block', 1000);
  // Second call: shareExists is false (already disabled), so this is a
  // no-op — confirms disabling twice never throws or double-counts.
  const disabledAgain = await disableShare(shareId, 'creator_block', 1000);
  assert.equal(disabledAgain, false);
  assert.equal(await getShare(shareId), null);
});

// ── restoreShare ──

test('restoreShare: brings back the ORIGINAL payload, unmodified', async () => {
  const { shareId } = await createShare({ synthetic: true, label: 'original' });
  await disableShare(shareId, 'creator_block', 1000);
  const restored = await restoreShare(shareId, 'creator_block');
  assert.equal(restored, true);
  assert.deepEqual(await getShare(shareId), { synthetic: true, label: 'original' });
});

test('restoreShare: refuses to touch a share disabled for a DIFFERENT reason', async () => {
  const { shareId } = await createShare({ synthetic: true });
  await disableShare(shareId, 'some_other_reason', 1000);
  const restored = await restoreShare(shareId, 'creator_block');
  assert.equal(restored, false);
  assert.equal(await getShare(shareId), null); // left disabled
});

test('restoreShare: a no-op (returns false) for a share that is not disabled at all', async () => {
  const { shareId } = await createShare({ synthetic: true });
  const restored = await restoreShare(shareId, 'creator_block');
  assert.equal(restored, false);
  assert.deepEqual(await getShare(shareId), { synthetic: true });
});

test('restoreShare: a no-op for a shareId that was never created', async () => {
  const restored = await restoreShare('never-created', 'creator_block');
  assert.equal(restored, false);
});

test('restoreShare: calling it twice is safe (idempotent) — second call is a harmless no-op', async () => {
  const { shareId } = await createShare({ synthetic: true });
  await disableShare(shareId, 'creator_block', 1000);
  assert.equal(await restoreShare(shareId, 'creator_block'), true);
  assert.equal(await restoreShare(shareId, 'creator_block'), false); // already restored — nothing to do
  assert.deepEqual(await getShare(shareId), { synthetic: true });
});

test('restoreShare: cannot resurrect a share that was independently hard-deleted (deleteShare is permanent regardless of any marker)', async () => {
  const { shareId } = await createShare({ synthetic: true });
  await disableShare(shareId, 'creator_block', 1000);
  await deleteShare(shareId); // some separate, independent permanent removal
  const restored = await restoreShare(shareId, 'creator_block');
  // The marker is still removed (restoreShare only inspects the marker,
  // not the payload), but there is nothing left to read either way.
  assert.equal(restored, true);
  assert.equal(await getShare(shareId), null);
});

// ── getShare's disabled-marker check, directly ──

test('getShare: a disabled share reads as unavailable exactly like a deleted or never-existed one', async () => {
  const { shareId } = await createShare({ synthetic: true });
  await disableShare(shareId, 'creator_block', 1000);
  assert.equal(await getShare(shareId), await getShare('never-created')); // both null
});

test('getShare: completely unaffected for a share that was never disabled', async () => {
  const { shareId } = await createShare({ synthetic: true, label: 'untouched' });
  assert.deepEqual(await getShare(shareId), { synthetic: true, label: 'untouched' });
});
