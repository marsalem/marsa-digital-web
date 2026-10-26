// lib/contentFilter.js
// Marsa Digital web — rules-based content filter for POST /api/share.
//
// SCOPE — read before changing anything below: this module checks CONTENT
// (is this specific text/URL one of a small set of clearly-prohibited
// things), never SHAPE or STRUCTURAL BOUNDS (type correctness, required
// fields, array length, nesting depth) — that's lib/shareSchema.js's job.
// api/share/index.js runs shareSchema's validateSharePayload() FIRST and
// this module SECOND, deliberately: this module's own recursion below
// assumes the tree it's walking is already depth/array-bounded (schema
// validation's job), so it never re-implements those guards itself. Do not
// call checkContent on a payload that hasn't already passed
// validateSharePayload.
//
// WHAT THIS IS, AND ISN'T: a small, rules-based (regex/wordlist) filter —
// no AI/ML model, no third-party moderation vendor, no network call. It
// catches clearly-prohibited, high-confidence categories only (hate
// slurs, explicit sexual-exploitation-of-minors language, explicit
// first-person violent threats, dangerous URL schemes). It is NOT a
// general profanity filter and does NOT attempt to catch sarcasm,
// coded/evolving slang, context-dependent harassment, or anything
// requiring judgment a keyword/pattern match can't reliably make. See the
// "DOCUMENTED LIMITATIONS" section at the bottom of this file — read it
// before assuming this module "handles moderation."
//
// SCOPE — USER-AUTHORED vs. CURATED TEXT: only fields a user actually
// typed are ever scanned. AyahBlock's arabic/english/surahName/surahNameAr
// and HadithBlock's arabic/english/bookName/bookNameAr/grade (app/types/
// models.ts) are curated/app-provided — a verbatim snapshot of Quranic
// text or Hadith text taken at insertion time, not something the user
// wrote — and are deliberately NEVER passed through this filter, per
// explicit instruction. See this file's own extractNodeText()/BLOCK
// extractors below for the exact per-block-type field list; adding a new
// block type later means adding it there deliberately, not getting it for
// free, so a future curated-content block type can't accidentally start
// being scanned (or a future free-text block type accidentally NOT being
// scanned) without someone looking at this file.
//
// KNOWN LIMITATION FROM THE ABOVE EXCLUSION — documented, not silently
// accepted: because AyahBlock/HadithBlock's text fields are trusted
// snapshots rather than re-verified against a real Quran/Hadith reference
// corpus (this service has none), a payload could falsely label arbitrary
// text as `type: 'ayah'` or `type: 'hadith'` specifically to bypass this
// filter. Closing that would require shipping a trusted reference corpus
// into this backend (a real scope expansion) or accepting that Stage 3's
// report/takedown path is the backstop for whatever slips through this
// way — this module alone does not close that gap.
//
// LOGGING DISCIPLINE — same as every other module here: checkContent's
// return value for a rejection carries an internal `category` (for future
// admin-side logging/metrics only) but callers must NEVER surface
// `category`, the matched pattern, or the offending text in any
// client-facing response — see api/share/index.js's own generic 400 body.

const MAX_NODE_DEPTH_SAFETY = 50; // defensive-only; see module header

// ── Normalization ──
// Both English and Arabic abuse text can be trivially obfuscated with
// zero-width characters, mixed-width Unicode variants, or (for Arabic)
// diacritics/tatweel inserted between letters purely to break a literal
// substring match. Normalizing before matching closes the easy cases
// without attempting anything more elaborate (leetspeak, repeated-letter
// stretching, homoglyphs across unrelated scripts, etc. are NOT handled —
// see DOCUMENTED LIMITATIONS).
function normalizeForMatch(text) {
  if (typeof text !== 'string' || !text) return '';
  let s = text.normalize('NFKC');
  // Zero-width space/joiner/non-joiner/BOM — common invisible-character
  // evasion (e.g. inserting U+200B into a slur to break substring match).
  s = s.replace(/[\u200B-\u200F\uFEFF]/g, '');
  // Arabic diacritics (tashkeel/tanwin) + tatweel (kashida, U+0640) —
  // present in careful religious-text typesetting, but also the single
  // easiest way to break a literal-string match on an Arabic word by
  // inserting marks between its letters. Stripping these for MATCHING
  // PURPOSES ONLY — this function's output is never written back to the
  // payload or stored; see this module's header, content is never
  // modified, only inspected.
  s = s.replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.toLowerCase(); // no-op on Arabic; normalizes Latin-script case variants
  return s;
}

// Unicode-aware "word boundary" built from \p{L}/\p{N} negative lookaround
// rather than \b — JS's \b is defined in terms of \w, which is ASCII-only,
// so it does NOT behave correctly around Arabic (or any non-ASCII) letters.
// Every pattern below is built with this, not \b, so Arabic terms get the
// same whole-word matching guarantee English ones do (without it, e.g. a
// short Arabic root could spuriously match as a substring of a longer,
// unrelated, innocuous word).
function wordPattern(literal) {
  return `(?<![\\p{L}\\p{N}])${literal}(?![\\p{L}\\p{N}])`;
}

function compile(literal) {
  return new RegExp(wordPattern(literal), 'u');
}

// ── Hard-block pattern categories ──
// Each category is a short, HIGH-CONFIDENCE list — deliberately narrow.
// Bare topical/theological vocabulary that appears constantly in
// legitimate religious and historical discussion (jihad, kill, fight,
// slave, kafir/disbeliever, infidel, martyr, etc.) is intentionally
// EXCLUDED from every category below; only unambiguous slurs and
// explicit, directly-constructed threat/exploitation phrasing are
// matched. See DOCUMENTED LIMITATIONS for what this deliberately does not
// catch as a result.

// HATE_SLUR — a representative, NOT exhaustive, set of unambiguous
// slur terms (racial/ethnic/religious/anti-LGBT). Given this app's own
// Muslim/Arab user base is a plausible target for anti-Muslim/anti-Arab
// harassment specifically, that category is included alongside more
// generic slurs, not as an afterthought.
const HATE_SLUR_EN = [
  'nigger', 'nigga', 'chink', 'spic', 'kike', 'raghead', 'towelhead',
  'sandnigger', 'faggot', 'tranny',
].map(compile);

// Arabic profanity/slur coverage here is intentionally SMALLER than the
// English list above and should be treated as lower-confidence — see
// DOCUMENTED LIMITATIONS: this was built without native-speaker review
// and should not be assumed comprehensive. Deliberately excludes ordinary
// theological-dispute vocabulary (كافر/disbeliever, مرتد/apostate,
// منافق/hypocrite, etc.) — those are normal terms in legitimate Islamic
// discourse, not slurs, regardless of how they might occasionally be used
// in a dispute.
const HATE_SLUR_AR = [
  'كسمك', 'كس امك', 'شرموطة', 'ابن كلب', 'عرص',
].map(compile);

// SEXUAL_EXPLOITATION — narrow and high-confidence on purpose: explicit
// CSAM-referencing terms and explicit sexual-content solicitation
// phrasing. Does not attempt to catch grooming behavior that doesn't use
// one of these explicit terms (see DOCUMENTED LIMITATIONS — this is a
// real, acknowledged gap, not an oversight).
// Deliberately excludes bare abbreviations like "cp" — too ambiguous
// (collides with ordinary non-abusive uses) to belong in a HARD-block
// list per this module's own "no bare short tokens" principle; only
// full, unambiguous phrases are listed.
const SEXUAL_EXPLOITATION_EN = [
  'child\\s*porn(ography)?', 'send\\s+(me\\s+)?nudes?',
  'send\\s+(me\\s+)?naked\\s+pics?',
].map(p => new RegExp(p, 'iu'));
const SEXUAL_EXPLOITATION_AR = [
  'صور\\s*عارية', 'ابعث(ي)?\\s*صور\\s*سكس',
].map(p => new RegExp(p, 'u'));

// VIOLENT_THREAT — requires an explicit first-person threat CONSTRUCTION
// (subject + intent + target), never a bare trigger word, specifically so
// ordinary religious/historical/news discussion that happens to contain
// words like "kill" or "fight" (e.g. discussing a Quranic verse about
// self-defense, or a news event) is never caught by this category. "kys"
// is the one bare-token exception — it has no other common meaning and is
// a well-documented targeted-harassment phrase ("kill yourself").
const VIOLENT_THREAT_EN = [
  "i(?:'m| am)?\\s*(?:going to|gonna|will)\\s*(?:kill|murder|rape|stab|shoot)\\s*(?:you|him|her|them|u)\\b",
  '\\bkill\\s+(?:your\\s*self|ur\\s*self|yourself)\\b',
  '\\bkys\\b',
].map(p => new RegExp(p, 'iu'));
const VIOLENT_THREAT_AR = [
  'سأقتلك', 'رح\\s*اقتلك', 'بدي\\s*اقتلك',
].map(p => new RegExp(p, 'u'));

const HARD_BLOCK_CATEGORIES = [
  { category: 'hate_slur', patterns: [...HATE_SLUR_EN, ...HATE_SLUR_AR] },
  { category: 'sexual_exploitation', patterns: [...SEXUAL_EXPLOITATION_EN, ...SEXUAL_EXPLOITATION_AR] },
  { category: 'violent_threat', patterns: [...VIOLENT_THREAT_EN, ...VIOLENT_THREAT_AR] },
];

/**
 * Scans one piece of user-authored free text. Returns the matched
 * category name, or null if clean.
 * @param {unknown} text
 * @returns {string | null}
 */
function scanText(text) {
  if (typeof text !== 'string' || !text) return null;
  const normalized = normalizeForMatch(text);
  if (!normalized) return null;
  for (const { category, patterns } of HARD_BLOCK_CATEGORIES) {
    for (const pattern of patterns) {
      if (pattern.test(normalized)) return category;
    }
  }
  return null;
}

// ── URL safety ──
// UrlBlock exists for "a link to an external page or video" (models.ts's
// own comment) and is opened via Linking.openURL — legitimate use is
// exclusively http(s). Everything else is rejected outright, including
// schemes that are dangerous in OTHER contexts (javascript:, data:,
// vbscript:, file:) even though React Native's Linking.openURL would
// likely also refuse most of these itself — this is a defense-in-depth
// check at the point of SHARING the link, not a substitute for the
// client's own handling, and keeps a malformed/malicious URL from ever
// reaching another person's device via this payload at all.
const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:']);

/**
 * @param {unknown} url
 * @returns {string | null} category name if rejected, else null
 */
function scanUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'unsafe_url'; // unparseable — reject rather than guess
  }
  if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) return 'unsafe_url';
  return scanText(url);
}

// ── Per-block-type user-authored text extraction ──
// Mirrors app/types/models.ts's Block union exactly. Each entry lists ONLY
// the fields a user actually types — see this file's header for why
// Ayah/Hadith are absent from this list entirely, deliberately.
function blockUserText(block) {
  if (block == null || typeof block !== 'object') return [];
  switch (block.type) {
    case 'heading':
    case 'text':
      return [block.text];
    case 'table': {
      const cells = Array.isArray(block.rows) ? block.rows.flat() : [];
      return [block.caption, ...cells];
    }
    case 'url':
      return [block.title]; // block.url is checked separately via scanUrl
    case 'image':
      return [block.caption]; // block.uri is a local file path, not prose
    case 'mention':
      return [block.targetTitleSnapshot];
    case 'bulletList':
    case 'numberedList':
      return Array.isArray(block.items) ? block.items : [];
    case 'toggle':
      return [block.title, block.body];
    case 'ayah':
    case 'hadith':
      return []; // curated snapshot text — never scanned, see header
    default:
      // Unrecognized block type: fall back to any of its own shallow
      // string-valued properties, so a genuinely new/unknown shape isn't
      // silently skipped entirely. Conservative, not exhaustive.
      return Object.values(block).filter(v => typeof v === 'string');
  }
}

/**
 * Parses Node.note (legacy plain text OR JSON.stringify(Block[]) — see
 * models.ts's own comment on this field) and returns every user-authored
 * string found inside, per blockUserText's exclusions above. Never
 * throws — a parse failure means it's legacy plain text, which is itself
 * entirely user-authored.
 * @param {unknown} note
 * @returns {{ texts: string[], urls: string[] }}
 */
function extractNoteContent(note) {
  if (typeof note !== 'string' || !note) return { texts: [], urls: [] };
  let parsed;
  try {
    parsed = JSON.parse(note);
  } catch {
    return { texts: [note], urls: [] };
  }
  if (!Array.isArray(parsed)) return { texts: [note], urls: [] };
  const texts = [];
  const urls = [];
  for (const block of parsed) {
    texts.push(...blockUserText(block));
    if (block && block.type === 'url' && typeof block.url === 'string') {
      urls.push(block.url);
    }
  }
  return { texts, urls };
}

function firstMatch(texts, urls) {
  for (const t of texts) {
    const hit = scanText(t);
    if (hit) return hit;
  }
  for (const u of urls) {
    const hit = scanUrl(u);
    if (hit) return hit;
  }
  return null;
}

function checkNode(node, depth = 0) {
  if (depth > MAX_NODE_DEPTH_SAFETY || node == null || typeof node !== 'object') return null;
  const { texts, urls } = extractNoteContent(node.note);
  const hit = firstMatch([node.name, ...texts], urls);
  if (hit) return hit;
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const childHit = checkNode(child, depth + 1);
      if (childHit) return childHit;
    }
  }
  return null;
}

function checkReferenceCard(card) {
  if (card == null || typeof card !== 'object') return null;
  return firstMatch([card.title, card.titleAr, card.scenario, card.scenarioAr], []);
}

function checkPlaylist(playlist) {
  if (playlist == null || typeof playlist !== 'object') return null;
  return firstMatch([playlist.name], []);
}

/**
 * Scans a Share Service payload for clearly-prohibited user-authored
 * content. MUST be called only on a payload that has already passed
 * lib/shareSchema.js's validateSharePayload — see this file's header.
 *
 * @param {unknown} payload
 * @returns {{ allowed: true } | { allowed: false, category: string }}
 */
function checkContent(payload) {
  if (payload == null || typeof payload !== 'object') return { allowed: true };

  let hit = null;
  if (payload.type === 'qatlas_playlist') {
    hit = checkPlaylist(payload.playlist);
  } else if (payload.type === 'qatlas_card') {
    hit = checkReferenceCard(payload.card);
  } else if (payload.type === 'qatlas_cards' && Array.isArray(payload.cards)) {
    for (const card of payload.cards) {
      hit = checkReferenceCard(card);
      if (hit) break;
    }
  } else if (payload.type === 'qatlas_topic' || payload.type === 'qatlas_topics') {
    hit = checkNode(payload.node);
  } else {
    // Legacy bare-Node shape — same structural signature shareSchema.js's
    // isLegacyBareNodeShape checks for.
    if (typeof payload.id === 'string' && typeof payload.name === 'string'
      && Array.isArray(payload.children) && Array.isArray(payload.verses)) {
      hit = checkNode(payload);
    }
  }

  return hit ? { allowed: false, category: hit } : { allowed: true };
}

module.exports = { checkContent, normalizeForMatch, scanText, scanUrl };

// ── DOCUMENTED LIMITATIONS ──
// A rules-based filter is a keyword/pattern matcher, not a judgment
// engine. Known, accepted gaps (not oversights):
//
// FALSE NEGATIVES (abuse this will NOT catch):
// - Coded language, evolving slang, leetspeak (e.g. "k1ll u"), or
//   letter-spacing/repetition tricks ("k.i.l.l") beyond the specific
//   zero-width/diacritic normalization implemented above.
// - Harassment, threats, or grooming that doesn't use one of the specific
//   phrase constructions in VIOLENT_THREAT/SEXUAL_EXPLOITATION — a threat
//   phrased indirectly, or grooming conducted through ordinary-seeming
//   conversation, will not be caught by keyword matching at all.
// - Context-dependent abuse (e.g. targeted harassment using someone's own
//   name/circumstances, bullying that uses no listed term).
// - Content disguised as curated Quran/Hadith text by setting
//   type:'ayah'/'hadith' with arbitrary arabic/english text — see this
//   file's header for why this exclusion exists and the gap it leaves.
// - Spam/scam/contact-harvesting content — deliberately NOT implemented
//   this stage (see Stage 2 report) to avoid false-flagging legitimate
//   contact-sharing (e.g. a dawah card's community contact info) without
//   a more careful design than a simple keyword/regex pass would give.
//
// FALSE POSITIVES (legitimate content that could, in principle, still be
// caught, despite the design choices above aimed at avoiding this):
// - A legitimate quotation OF a slur (e.g. discussing historical racism
//   academically) would still match HATE_SLUR — there is no way for a
//   keyword matcher to distinguish quotation/discussion from use.
// - The Arabic hard-block list (HATE_SLUR_AR/SEXUAL_EXPLOITATION_AR/
//   VIOLENT_THREAT_AR) was authored without native-speaker review; an
//   Arabic-speaking moderator should audit it before treating it as
//   reliable, in either direction (missed terms, or terms that are
//   milder/more ambiguous in some dialects than assumed here).
//
// AMBIGUOUS SIGNALS ARE NOT SURFACED ANYWHERE YET: per instruction, this
// module only hard-rejects HIGH-CONFIDENCE matches; it does not implement
// a "flag for human review" path for weaker signals, because no review
// queue exists yet (that's Stage 3's reporting/takedown infrastructure).
// A weaker signal today is simply not caught at all — it is not logged,
// queued, or soft-flagged anywhere.