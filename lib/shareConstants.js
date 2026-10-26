// lib/shareConstants.js
// Marsa Digital web — shared constants for the Share Service (Quran
// Atlas's "share a Playlist/Topic/Reference Card as a link" backend).
// Kept in their own file, not inlined in shareService.js or the API
// routes, so both can reference the same values and so these can be
// adjusted later without touching any actual logic.

// Server-side cap on a single share's payload size, enforced in
// api/share/index.js before it ever reaches shareService.createShare.
//
// Why 250 KB: every payload this backend has ever needed to hold
// (Playlists today; Topics and Reference Cards are the planned next
// migrations off the old .qatlas-file share) is text-only — verse
// references, notes, titles. Topic pages CAN contain image blocks, but
// their `uri` is a local device file path (see the Quran Atlas app's
// own types/models.ts ImageBlock comment), never embedded image bytes,
// so no payload this service stores is ever expected to carry binary
// media. Even a large topic tree (hundreds of subtopics/verses/notes)
// realistically tops out in the tens-to-low-hundreds of KB. 250 KB is a
// generous multiple of that realistic ceiling — enough headroom that no
// legitimate share should ever hit it — while still bounding the
// abuse/cost surface of a public write endpoint. If a genuinely larger
// shareable object type is ever added, raise this constant rather than
// reintroducing a second sharing mechanism.
const MAX_PAYLOAD_BYTES = 250 * 1024;

// Default TTL (seconds) for a share when the caller doesn't specify one.
// One year: long enough that "the recipient finally opened the link
// months later" never breaks, while still giving automatic, zero-
// maintenance cleanup instead of accumulating shared content (which may
// include personal reflections/notes) forever. Callers can override this
// per share via shareService.createShare's own ttlSeconds option.
const DEFAULT_TTL_SECONDS = 365 * 24 * 60 * 60;

// ── Structural bounds (lib/shareSchema.js) ──
// The flat MAX_PAYLOAD_BYTES cap above bounds total size but not SHAPE: a
// small payload can still be pathologically deep (a long children->children
// chain) or pathologically wide (thousands of tiny array entries). Both are
// real, demonstrated issues, not hypothetical — api/import-preview.js's
// countVerses() recurses once per nesting level with no depth guard, so a
// single-child chain a few thousand nodes deep (easily inside 250KB) can
// exhaust the call stack on every unauthenticated viewer who opens that
// link's preview page, before this payload ever reaches an app user.
//
// MAX_NODE_DEPTH: generous multiple of any topic hierarchy actually
// produced by the app's own Workspace UI (subtopics nest a handful of
// levels in practice) — high enough that no legitimate Topic export is
// ever close to it, low enough that validateSharePayload's own recursion
// (which walks the same shape countVerses does) can never come near
// overflowing the stack itself while checking this.
const MAX_NODE_DEPTH = 25;

// MAX_ARRAY_LENGTH: applies uniformly to every array field across all
// payload shapes (Node.verses/children/hadiths, ReferenceCard.verseRefs/
// hadithRefs, Playlist.items, a cards/topics bundle's own top-level array,
// BulletListBlock/NumberedListBlock.items). 1000 is far beyond anything a
// person assembles by hand through the app's own UI, while still bounding
// the worst case combination of this and MAX_NODE_DEPTH.
const MAX_ARRAY_LENGTH = 1000;

// MAX_TOTAL_NODES: a combined backstop across an entire Node tree (Topic or
// Topics-bundle), independent of depth/per-array width alone — guards the
// "wide at every level" shape (e.g. 50 children x 50 children) that could
// stay under both limits above individually while still producing a huge
// total node count.
const MAX_TOTAL_NODES = 5000;

// Short free-text fields (Node.name, ReferenceCard.title/titleAr, Playlist.
// name, Verse/HadithNodeRef.label, block captions/titles) vs. long free-text
// fields (Node.note, which carries either legacy plain text or
// JSON.stringify(Block[]) for an entire topic page — can legitimately be
// sizable). Both are still well inside MAX_PAYLOAD_BYTES; these exist to
// stop one single field from being used to stuff disproportionate content
// relative to its own purpose, independent of the overall payload budget.
const MAX_SHORT_STRING_LENGTH = 500;
const MAX_LONG_STRING_LENGTH = 50000;

// ── Stage 3: reporting, takedown, creator blocking ──

// A report must identify WHICH share it's about and WHY, nothing more —
// no reporter email/name/identifier is ever collected (see lib/
// reportService.js). shareId's own length bound is generous rather than
// tied exactly to generateShareId's current 22-char base64url output, so
// this doesn't quietly break if that encoding ever changes.
const MAX_SHARE_ID_LENGTH = 200;
const MAX_REPORT_DETAILS_LENGTH = 1000;

// Fixed enum, not free text — keeps reports structured enough to triage
// at a glance from lib/reportService.js's own listOpenReports() output
// without needing to read `details` for every single one.
const REPORT_REASONS = ['hate_speech', 'harassment', 'sexual_content', 'spam', 'other'];

// Reports persist for the same 1-year ceiling shares themselves do — long
// enough that a slow-to-surface report (e.g. forwarded via the support
// inbox weeks later) still has something to act on, without a separate,
// undisclosed retention period for report data specifically.
const REPORT_TTL_SECONDS = DEFAULT_TTL_SECONDS;

// How long a blocked creator token stays blocked once an admin blocks it
// (lib/creatorBlock.js). Same 1-year ceiling as everything else in this
// service, rather than "forever" — see this project's own retention
// principle (nothing persists indefinitely without that being a stated,
// deliberate choice). Re-applying the block (calling block-creator again)
// after it lapses is a normal, expected admin action, not a bug.
const BLOCK_TTL_SECONDS = DEFAULT_TTL_SECONDS;

module.exports = {
  MAX_PAYLOAD_BYTES,
  DEFAULT_TTL_SECONDS,
  MAX_NODE_DEPTH,
  MAX_ARRAY_LENGTH,
  MAX_TOTAL_NODES,
  MAX_SHORT_STRING_LENGTH,
  MAX_LONG_STRING_LENGTH,
  MAX_SHARE_ID_LENGTH,
  MAX_REPORT_DETAILS_LENGTH,
  REPORT_REASONS,
  REPORT_TTL_SECONDS,
  BLOCK_TTL_SECONDS,
};
