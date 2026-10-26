// api/admin/block-creator.js
// Marsa Digital web — POST /api/admin/block-creator: block the creator
// token associated with `shareId` from creating any FUTURE share, AND
// (Stage 3.1) disable every OTHER currently-live share known to have
// come from that same token — see lib/creatorBlock.js's own header for
// the bounded, self-purging index this relies on and why it's safe to
// call repeatedly. `shareId` itself is included among the shares
// disabled by this call — a separate api/admin/takedown.js call isn't
// needed for it specifically, though takedown.js remains the right tool
// for disabling a single share WITHOUT also blocking its creator (e.g. a
// first-time, non-malicious mistake).
//
// Body: { shareId: string }.
// Response: { blocked: boolean, reason?: string, disabledShareCount?: number }
// — blocked:false (with a reason) when the share has no associated
// creator token at all (it predates this feature, or came from an app
// version that doesn't send one yet) — there is nothing to block in that
// case, and this is not an error. disabledShareCount counts only shares
// that were actually still live at the moment of this call (an already-
// expired or already-removed sibling share is correctly not counted —
// see creatorBlock.js's own EXPIRED SHARES note).

const { rejectUnlessAdmin } = require('../../lib/adminAuth');
const { checkAdminRateLimit } = require('../../lib/rateLimit');
const { blockCreatorForShare } = require('../../lib/creatorBlock');
const { MAX_SHARE_ID_LENGTH } = require('../../lib/shareConstants');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (rejectUnlessAdmin(req, res)) return;

  const { success: withinRateLimit } = await checkAdminRateLimit(req);
  if (!withinRateLimit) {
    res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    return;
  }

  const body = req.body;
  const shareId = body && typeof body === 'object' ? body.shareId : undefined;
  if (typeof shareId !== 'string' || !shareId || shareId.length > MAX_SHARE_ID_LENGTH) {
    res.status(400).json({ error: 'A valid shareId is required.' });
    return;
  }

  try {
    const result = await blockCreatorForShare(shareId);
    res.status(200).json(result);
  } catch (err) {
    console.error('blockCreatorForShare failed:', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Could not block creator.' });
  }
};
