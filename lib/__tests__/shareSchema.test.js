// lib/__tests__/shareSchema.test.js
// Run with: node --test lib/__tests__
//
// Covers two things explicitly called for in the audit this module came
// out of: (1) legitimate payloads the app actually produces today must
// keep validating (backward compatibility), and (2) the structural-DoS
// shapes (deep chains, oversized arrays) must be rejected before they ever
// reach storage.

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSharePayload } = require('../shareSchema');
const { MAX_NODE_DEPTH, MAX_ARRAY_LENGTH } = require('../shareConstants');

function makeVerse(i) {
  return { id: `v${i}`, surah: 2, ayah: i + 1, label: `2:${i + 1}` };
}

function makeLeafNode(id) {
  return { id, name: `Node ${id}`, verses: [], children: [] };
}

// ── Backward compatibility: real envelope shapes from app/utils/sharing.ts ──

test('valid qatlas_playlist payload (matches buildPlaylistSharePayload output)', () => {
  const payload = {
    type: 'qatlas_playlist',
    version: 1,
    playlist: {
      id: 'pl_1',
      name: 'Morning Recitation',
      items: [
        { surah: 1 },
        { surah: 2, ayahStart: 1, ayahEnd: 20, repeatCount: 3 },
      ],
      createdAt: 1700000000000,
      artworkId: 'artwork_12',
    },
  };
  assert.deepEqual(validateSharePayload(payload), { valid: true });
});

test('valid qatlas_card payload (matches buildCardSharePayload output)', () => {
  const payload = {
    type: 'qatlas_card',
    version: 1,
    card: {
      id: 'card_1',
      title: 'On patience',
      titleAr: 'عن الصبر',
      scenario: 'Someone asks about hardship',
      scenarioAr: 'يسأل أحدهم عن الصعوبات',
      verseRefs: [{ surah: 2, ayah: 155 }],
      hadithRefs: [{ bookId: 'bukhari', hadithId: 123 }],
      color: '#4CAF50',
    },
  };
  assert.deepEqual(validateSharePayload(payload), { valid: true });
});

test('valid qatlas_cards bundle payload', () => {
  const payload = {
    type: 'qatlas_cards',
    version: 1,
    cards: [
      { id: 'c1', title: 'A', titleAr: 'أ', scenario: 's', scenarioAr: 'س', verseRefs: [], color: '#000' },
      { id: 'c2', title: 'B', titleAr: 'ب', scenario: 's', scenarioAr: 'س', verseRefs: [], color: '#000' },
    ],
  };
  assert.deepEqual(validateSharePayload(payload), { valid: true });
});

test('valid qatlas_topic payload with nested children, hadiths, and a block-editor note', () => {
  const payload = {
    type: 'qatlas_topic',
    version: 1,
    node: {
      id: 'n1',
      name: 'Patience',
      color: '#fff',
      colorIndex: 2,
      note: JSON.stringify([{ id: 'b1', type: 'text', text: 'Some reflection' }]),
      verses: [makeVerse(0), makeVerse(1)],
      hadiths: [{ id: 'h1', bookId: 'bukhari', hadithId: 1, label: 'Bukhari 1' }],
      children: [
        { id: 'n1a', name: 'Subtopic', verses: [], children: [] },
      ],
    },
  };
  assert.deepEqual(validateSharePayload(payload), { valid: true });
});

test('valid qatlas_topics bundle (bundle_ wrapper node)', () => {
  const payload = {
    type: 'qatlas_topics',
    version: 1,
    node: {
      id: 'bundle_123',
      name: 'Shared Topics',
      verses: [],
      children: [makeLeafNode('t1'), makeLeafNode('t2')],
    },
  };
  assert.deepEqual(validateSharePayload(payload), { valid: true });
});

test('valid legacy bare-Node shape (no type field) still accepted on write', () => {
  const payload = { id: 'legacy1', name: 'Old export', verses: [], children: [makeLeafNode('legacy1a')] };
  assert.deepEqual(validateSharePayload(payload), { valid: true });
});

// ── Rejections: wrong shape / wrong types ──

test('rejects null/non-object payloads', () => {
  assert.equal(validateSharePayload(null).valid, false);
  assert.equal(validateSharePayload('a string').valid, false);
  assert.equal(validateSharePayload([1, 2, 3]).valid, false);
});

test('rejects unrecognized type discriminator', () => {
  assert.equal(validateSharePayload({ type: 'something_else', version: 1 }).valid, false);
});

test('rejects unsupported version', () => {
  const payload = { type: 'qatlas_playlist', version: 2, playlist: { id: 'p', name: 'n', items: [], createdAt: 1 } };
  assert.equal(validateSharePayload(payload).valid, false);
});

test('rejects a playlist item with a non-numeric surah', () => {
  const payload = {
    type: 'qatlas_playlist',
    version: 1,
    playlist: { id: 'p', name: 'n', items: [{ surah: 'two' }], createdAt: 1 },
  };
  assert.equal(validateSharePayload(payload).valid, false);
});

test('rejects a reference card missing a required field', () => {
  const payload = {
    type: 'qatlas_card',
    version: 1,
    card: { id: 'c', title: 'T', scenario: 's', scenarioAr: 'س', verseRefs: [], color: '#000' }, // titleAr missing
  };
  assert.equal(validateSharePayload(payload).valid, false);
});

// ── Structural DoS guards: the actual bug class api/import-preview.js's
// unbounded countVerses() recursion is vulnerable to ──

test('rejects a Node chain deeper than MAX_NODE_DEPTH', () => {
  let node = makeLeafNode('leaf');
  for (let i = 0; i < MAX_NODE_DEPTH + 5; i++) {
    node = { id: `n${i}`, name: `n${i}`, verses: [], children: [node] };
  }
  const payload = { type: 'qatlas_topic', version: 1, node };
  assert.equal(validateSharePayload(payload).valid, false);
});

test('accepts a Node chain exactly at MAX_NODE_DEPTH', () => {
  let node = makeLeafNode('leaf');
  for (let i = 0; i < MAX_NODE_DEPTH - 1; i++) {
    node = { id: `n${i}`, name: `n${i}`, verses: [], children: [node] };
  }
  const payload = { type: 'qatlas_topic', version: 1, node };
  assert.equal(validateSharePayload(payload).valid, true);
});

test('rejects a verses array longer than MAX_ARRAY_LENGTH', () => {
  const verses = Array.from({ length: MAX_ARRAY_LENGTH + 1 }, (_, i) => makeVerse(i));
  const payload = { type: 'qatlas_topic', version: 1, node: { id: 'n', name: 'n', verses, children: [] } };
  assert.equal(validateSharePayload(payload).valid, false);
});

test('rejects a children array longer than MAX_ARRAY_LENGTH', () => {
  const children = Array.from({ length: MAX_ARRAY_LENGTH + 1 }, (_, i) => makeLeafNode(`c${i}`));
  const payload = { type: 'qatlas_topic', version: 1, node: { id: 'n', name: 'n', verses: [], children } };
  assert.equal(validateSharePayload(payload).valid, false);
});

test('rejects a wide-at-every-level tree that exceeds MAX_TOTAL_NODES despite staying under per-array and depth limits', () => {
  // 3 levels of 100 children each = 1 + 100 + 100*100 = 10101 nodes, each
  // individual array well under MAX_ARRAY_LENGTH (1000) and depth well
  // under MAX_NODE_DEPTH (25), but total node count exceeds MAX_TOTAL_NODES
  // (5000) — this is exactly the "stays under every per-branch limit
  // individually" shape the combined backstop exists for.
  const leafChildren = Array.from({ length: 100 }, (_, i) => makeLeafNode(`leaf${i}`));
  const midChildren = Array.from({ length: 100 }, (_, i) => ({
    id: `mid${i}`, name: `mid${i}`, verses: [], children: leafChildren,
  }));
  const root = { id: 'root', name: 'root', verses: [], children: midChildren };
  const payload = { type: 'qatlas_topic', version: 1, node: root };
  assert.equal(validateSharePayload(payload).valid, false);
});

test('rejects an oversized string field beyond MAX_SHORT_STRING_LENGTH', () => {
  const payload = {
    type: 'qatlas_topic',
    version: 1,
    node: { id: 'n', name: 'x'.repeat(10000), verses: [], children: [] },
  };
  assert.equal(validateSharePayload(payload).valid, false);
});
