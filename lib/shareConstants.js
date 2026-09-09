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

module.exports = { MAX_PAYLOAD_BYTES, DEFAULT_TTL_SECONDS };
