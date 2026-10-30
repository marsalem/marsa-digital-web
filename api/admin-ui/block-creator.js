// api/admin-ui/block-creator.js
// Marsa Digital web — POST /api/admin-ui/block-creator: block the
// creator token associated with `shareId` and disable every other
// currently-live share from that same token. Session-cookie +
// CSRF-header gated (see lib/adminSession.js) — the Bearer-token
// equivalent, api/admin/block-creator.js, is untouched; this calls the
// same lib/creatorBlock.js function directly.
//
// Body: { shareId: string, reportId?: string } — same optional-reportId
// contract as api/admin-ui/takedown.js (validated the same way: if
// provided, must be a non-empty string).
// Response: { blocked: boolean, reason?: string, disabledShareCount?: number }
// — blocked:false (with a reason) when the share has no associated
// creator token at all; this is the exact signal the UI uses to show
// "creator blocking unavailable for this share" rather than treating it
// as an error. See lib/creatorBlock.js's own header for the full design.
//
// REPORT RESOLUTION ONLY ON AN ACTUAL BLOCK — unlike takedown.js (whose
// deleteShare always has a real effect, whether or not the share still
// existed), blockCreatorForShare has a genuine no-op branch
// (blocked:false, "nothing to block"). Resolving the triggering report
// in that case would make it vanish from the open-reports list even
// though the reported content is still live and nothing was done about
// it, so the report is only resolved when blocked === true, after
// confirming (same as takedown.js) that the report's own shareId
// matches the one just acted on.

const { checkAdminRateLimit } = require('../../lib/rateLimit');
const { rejectUnlessValidSession, rejectUnlessSameOriginHeader } = require('../../lib/adminSession');
const { blockCreatorForShare } = require('../../lib/creatorBlock');
const { resolveReport, getReport } = require('../../lib/reportService');
const { MAX_SHARE_ID_LENGTH } = require('../../lib/shareConstants');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (await rejectUnlessValidSession(req, res)) return;
  if (rejectUnlessSameOriginHeader(req, res)) return;

  const { success: withinRateLimit } = await checkAdminRateLimit(req);
  if (!withinRateLimit) {
    res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    return;
  }

  const body = req.body;
  const shareId = body && typeof body === 'object' ? body.shareId : undefined;
  const reportId = body && typeof body === 'object' ? body.reportId : undefined;
  if (typeof shareId !== 'string' || !shareId || shareId.length > MAX_SHARE_ID_LENGTH) {
    res.status(400).json({ error: 'A valid shareId is required.' });
    return;
  }
  if (reportId !== undefined && (typeof reportId !== 'string' || !reportId)) {
    res.status(400).json({ error: 'reportId, if provided, must be a non-empty string.' });
    return;
  }

  try {
    const result = await blockCreatorForShare(shareId);
    if (result.blocked && reportId) {
      const report = await getReport(reportId);
      if (report && report.shareId === shareId) {
        await resolveReport(reportId);
      }
    }
    res.status(200).json(result);
  } catch (err) {
    console.error('admin-ui blockCreatorForShare failed:', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Could not block creator.' });
  }
};
