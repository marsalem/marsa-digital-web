// lib/__tests__/contentFilter.test.js
// Run with: node --test lib/__tests__
//
// Covers every payload shape (matching shareSchema.test.js's own coverage),
// every user-authored field per content type, every Block type's
// user-authored text, the Ayah/Hadith curated-content exclusion
// (regression test — see contentFilter.js's own header), benign Arabic
// and English religious/educational content that must NOT be flagged,
// unsafe URL schemes, normalization/obfuscation handling, and malformed
// notes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkContent, scanText, scanUrl, normalizeForMatch } = require('../contentFilter');

function leaf(id, extra = {}) {
  return { id, name: id, verses: [], children: [], ...extra };
}

// ── Benign content must never be flagged ──
// (Requirement: avoid broad rules that flag legitimate religious/
// educational content.)

test('benign English religious/educational text is never flagged', () => {
  const samples = [
    'I love studying the Quran and reflecting on patience.',
    'The verse discusses when it is permissible to fight in self-defense.',
    'The scholars discuss who is considered a kafir in classical fiqh.',
    'This topic covers the story of the Prophet and his companions.',
    'Jihad in its primary sense means struggle against one\'s own ego.',
    'A reflection on forgiveness and mercy in difficult times.',
  ];
  for (const s of samples) {
    assert.equal(scanText(s), null, `expected clean: "${s}"`);
  }
});

test('benign Arabic religious/educational text is never flagged', () => {
  const samples = [
    'أحب دراسة القرآن والتفكر في الصبر',
    'تتحدث الآية عن جواز القتال في حالة الدفاع عن النفس',
    'يتناول هذا الموضوع قصة النبي صلى الله عليه وسلم وأصحابه',
    'تأملات في معنى التوبة والرحمة',
    'يناقش العلماء من يعتبر كافرا في الفقه الكلاسيكي',
  ];
  for (const s of samples) {
    assert.equal(scanText(s), null, `expected clean: "${s}"`);
  }
});

// ── Hard-block categories, EN + AR ──

test('flags an unambiguous English slur', () => {
  assert.equal(scanText('you dirty faggot'), 'hate_slur');
});

test('flags an unambiguous Arabic slur', () => {
  assert.equal(scanText('يا كسمك'), 'hate_slur');
});

test('flags an explicit English violent threat construction', () => {
  assert.equal(scanText('i am going to kill you tomorrow'), 'violent_threat');
  assert.equal(scanText('kys'), 'violent_threat');
});

test('flags an explicit Arabic violent threat construction', () => {
  assert.equal(scanText('سأقتلك غدا'), 'violent_threat');
});

test('flags explicit sexual-exploitation solicitation phrasing', () => {
  assert.equal(scanText('please send me nudes'), 'sexual_exploitation');
  assert.equal(scanText('this is child pornography'), 'sexual_exploitation');
});

test('does NOT flag bare ambiguous short tokens like "cp"', () => {
  assert.equal(scanText('cp the file to another folder'), null);
});

// ── Normalization / obfuscation resistance ──

test('catches a slur obfuscated with a zero-width character', () => {
  assert.equal(scanText('fa​ggot'), 'hate_slur');
});

test('catches an Arabic slur obfuscated with diacritics inserted between letters', () => {
  assert.equal(scanText('عَرْص'), 'hate_slur');
});

test('is case-insensitive for English', () => {
  assert.equal(scanText('FAGGOT'), 'hate_slur');
  assert.equal(scanText('FaGgOt'), 'hate_slur');
});

test('does not match a slur as a substring of an unrelated longer word', () => {
  // "cpu" must not trip "cp"-style bare-token matching (already excluded
  // above) and whole-word boundaries must prevent partial matches inside
  // legitimate longer words for every listed term.
  assert.equal(scanText('classical fiqh scholarship'), null);
});

// ── URL scheme safety ──

test('rejects dangerous URL schemes', () => {
  assert.equal(scanUrl('javascript:alert(1)'), 'unsafe_url');
  assert.equal(scanUrl('data:text/html,<script>alert(1)</script>'), 'unsafe_url');
  assert.equal(scanUrl('vbscript:msgbox(1)'), 'unsafe_url');
  assert.equal(scanUrl('file:///etc/passwd'), 'unsafe_url');
});

test('allows http/https URLs', () => {
  assert.equal(scanUrl('https://youtube.com/watch?v=abc'), null);
  assert.equal(scanUrl('http://example.com/article'), null);
});

test('rejects an unparseable URL string rather than guessing', () => {
  assert.equal(scanUrl('not a url at all'), 'unsafe_url');
});

test('also scans the URL string itself for hard-block terms', () => {
  assert.equal(scanUrl('https://example.com/faggot'), 'hate_slur');
});

// ── Per-payload-type coverage ──

test('qatlas_playlist: clean name allowed, abusive name rejected', () => {
  const clean = { type: 'qatlas_playlist', version: 1, playlist: { id: 'p', name: 'Morning Recitation', items: [], createdAt: 1 } };
  assert.deepEqual(checkContent(clean), { allowed: true });

  const bad = { type: 'qatlas_playlist', version: 1, playlist: { id: 'p', name: 'you dirty faggot', items: [], createdAt: 1 } };
  assert.deepEqual(checkContent(bad), { allowed: false, category: 'hate_slur' });
});

test('qatlas_card: each user-authored field is checked independently', () => {
  const base = { id: 'c', title: 'T', titleAr: 'ت', scenario: 's', scenarioAr: 'س', verseRefs: [], color: '#000' };
  for (const field of ['title', 'titleAr', 'scenario', 'scenarioAr']) {
    const card = { ...base, [field]: 'kys' };
    const result = checkContent({ type: 'qatlas_card', version: 1, card });
    assert.equal(result.allowed, false, `expected ${field} to be caught`);
  }
});

test('qatlas_cards bundle: a single bad card among clean ones is caught', () => {
  const payload = {
    type: 'qatlas_cards', version: 1,
    cards: [
      { id: 'c1', title: 'Clean', titleAr: 'نظيف', scenario: 's', scenarioAr: 'س', verseRefs: [], color: '#000' },
      { id: 'c2', title: 'you dirty faggot', titleAr: 'ت', scenario: 's', scenarioAr: 'س', verseRefs: [], color: '#000' },
    ],
  };
  assert.equal(checkContent(payload).allowed, false);
});

// ── Topic / Node: every block type's user-authored text ──

function topicWithBlock(block) {
  return {
    type: 'qatlas_topic', version: 1,
    node: { id: 'n1', name: 'Topic', verses: [], children: [], note: JSON.stringify([block]) },
  };
}

test('heading block text is checked', () => {
  assert.equal(checkContent(topicWithBlock({ id: 'b', type: 'heading', level: 1, text: 'kys' })).allowed, false);
});

test('text block text is checked', () => {
  assert.equal(checkContent(topicWithBlock({ id: 'b', type: 'text', text: 'kys' })).allowed, false);
});

test('table caption and cells are checked', () => {
  assert.equal(checkContent(topicWithBlock({ id: 'b', type: 'table', rows: [['kys']], caption: 'ok' })).allowed, false);
  assert.equal(checkContent(topicWithBlock({ id: 'b', type: 'table', rows: [['ok']], caption: 'kys' })).allowed, false);
});

test('url block title is checked, and its url scheme is checked', () => {
  assert.equal(checkContent(topicWithBlock({ id: 'b', type: 'url', url: 'https://example.com', title: 'kys' })).allowed, false);
  assert.equal(checkContent(topicWithBlock({ id: 'b', type: 'url', url: 'javascript:alert(1)', title: 'ok' })).allowed, false);
});

test('image block caption is checked; local uri is not treated as prose', () => {
  assert.equal(checkContent(topicWithBlock({ id: 'b', type: 'image', uri: 'file:///local/path.jpg', caption: 'kys' })).allowed, false);
  // A benign local uri containing no prose must not itself trip anything.
  assert.deepEqual(checkContent(topicWithBlock({ id: 'b', type: 'image', uri: 'file:///local/path.jpg', caption: 'ok' })), { allowed: true });
});

test('mention block target title snapshot is checked', () => {
  assert.equal(checkContent(topicWithBlock({ id: 'b', type: 'mention', targetNodeId: 'x', targetTitleSnapshot: 'kys' })).allowed, false);
});

test('bulletList and numberedList items are checked', () => {
  assert.equal(checkContent(topicWithBlock({ id: 'b', type: 'bulletList', items: ['ok', 'kys'] })).allowed, false);
  assert.equal(checkContent(topicWithBlock({ id: 'b', type: 'numberedList', items: ['ok', 'kys'] })).allowed, false);
});

test('toggle title and body are checked', () => {
  assert.equal(checkContent(topicWithBlock({ id: 'b', type: 'toggle', title: 'kys', body: 'ok' })).allowed, false);
  assert.equal(checkContent(topicWithBlock({ id: 'b', type: 'toggle', title: 'ok', body: 'kys' })).allowed, false);
});

// ── Regression test: curated Ayah/Hadith text is NEVER filtered ──
// (Requirement: do not filter Quranic verses, translations, or Hadith
// text, even though those same fields could in principle contain any
// string value.)

test('REGRESSION: AyahBlock arabic/english/surahName fields are never scanned, even if they contain a hard-block term', () => {
  const payload = topicWithBlock({
    id: 'b', type: 'ayah', surah: 2, ayah: 191,
    arabic: 'فاقتلوهم حيث وجدتموهم', // real Quranic text containing ف-ق-ت-ل (root of "kill") — must NOT be flagged
    english: 'and kill them wherever you overtake them', // real Saheeh International translation wording
    surahName: 'Al-Baqarah', surahNameAr: 'البقرة',
  });
  assert.deepEqual(checkContent(payload), { allowed: true });
});

test('REGRESSION: HadithBlock arabic/english/bookName/grade fields are never scanned', () => {
  const payload = topicWithBlock({
    id: 'b', type: 'hadith', bookId: 'bukhari', hadithId: 1,
    arabic: 'نص حديث', english: 'hadith text', bookName: 'Sahih al-Bukhari', bookNameAr: 'صحيح البخاري', grade: 'Sahih',
  });
  assert.deepEqual(checkContent(payload), { allowed: true });
});

test('a clean topic with a legitimate mixed Ayah+Text note is allowed in full', () => {
  const payload = {
    type: 'qatlas_topic', version: 1,
    node: {
      id: 'n1', name: 'Patience', verses: [], children: [],
      note: JSON.stringify([
        { id: 'b1', type: 'ayah', surah: 2, ayah: 155, arabic: 'نص آية', english: 'verse text', surahName: 'Al-Baqarah', surahNameAr: 'البقرة' },
        { id: 'b2', type: 'text', text: 'A reflection: patience is central to faith.' },
      ]),
    },
  };
  assert.deepEqual(checkContent(payload), { allowed: true });
});

// ── Nested children (qatlas_topics bundle) ──

test('abusive content nested deep in a topics bundle child is still caught', () => {
  const payload = {
    type: 'qatlas_topics', version: 1,
    node: {
      id: 'bundle_1', name: 'Bundle', verses: [], children: [
        leaf('t1'),
        { id: 't2', name: 'ok', verses: [], children: [leaf('t2a', { name: 'kys' })] },
      ],
    },
  };
  assert.equal(checkContent(payload).allowed, false);
});

// ── Legacy bare-Node shape (Stage 1's preserved shape) ──

test('legacy bare-Node shape: clean content allowed', () => {
  const payload = { id: 'legacy1', name: 'Clean legacy topic', verses: [], children: [] };
  assert.deepEqual(checkContent(payload), { allowed: true });
});

test('legacy bare-Node shape: abusive name rejected', () => {
  const payload = { id: 'legacy1', name: 'kys', verses: [], children: [] };
  assert.equal(checkContent(payload).allowed, false);
});

test('legacy bare-Node shape: abusive content in a child node is caught', () => {
  const payload = { id: 'legacy1', name: 'ok', verses: [], children: [leaf('legacy1a', { name: 'kys' })] };
  assert.equal(checkContent(payload).allowed, false);
});

// ── Malformed / unusual note values ──

test('a plain (non-JSON) legacy note string is scanned as plain text', () => {
  const payload = topicWithNote('kys');
  assert.equal(checkContent(payload).allowed, false);
});

test('a note that is valid JSON but not an array is treated as plain text', () => {
  const payload = topicWithNote(JSON.stringify({ not: 'an array' }));
  // The raw string itself contains no hard-block term, so this must be allowed.
  assert.deepEqual(checkContent(payload), { allowed: true });
});

test('an unrecognized block type falls back to scanning its own string fields', () => {
  const payload = topicWithBlock({ id: 'b', type: 'some_future_block', futureField: 'kys' });
  assert.equal(checkContent(payload).allowed, false);
});

test('checkContent never throws on garbage input', () => {
  assert.doesNotThrow(() => checkContent(null));
  assert.doesNotThrow(() => checkContent(undefined));
  assert.doesNotThrow(() => checkContent('a string'));
  assert.doesNotThrow(() => checkContent({ type: 'unknown_type' }));
  assert.doesNotThrow(() => checkContent({ type: 'qatlas_topic', version: 1, node: null }));
});

function topicWithNote(note) {
  return { type: 'qatlas_topic', version: 1, node: { id: 'n1', name: 'Topic', verses: [], children: [], note } };
}

// ── normalizeForMatch sanity (exported for transparency/testability) ──

test('normalizeForMatch strips zero-width characters and lowercases Latin text', () => {
  assert.equal(normalizeForMatch('FA​GGOT'), 'faggot');
});

test('normalizeForMatch strips Arabic diacritics without altering the base letters', () => {
  assert.equal(normalizeForMatch('عَرْص'), 'عرص');
});
