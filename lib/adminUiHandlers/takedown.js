// lib/adminUiHandlers/takedown.js
// Relocated from api/admin-ui/takedown.js — now required by
// api/admin-ui/[action].js (see that file's own header) rather than
// deployed as its own Vercel Function. Logic and security checks below
// are unchanged by the move.
//
// Marsa Digital web — POST /api/admin-ui/takedown: disable a shared
// link. Session-cookie + CSRF-header gated (see lib/adminSession.js) —
// the Bearer-token equivalent, api/admin/takedown.js, is untouched; this
// calls the same lib/shareService.js/lib/reportService.js functions
// directly.
//
// Body: { shareId: string, reportId?: string } — same contract as
// api/admin/takedown.js (see that file's own header for the
// reportId-is-optional reasoning).

const { checkAdminRateLimit } = require('../rateLimit');
const { rejectUnlessValidSession, rejectUnlessSameOriginHeader } = require('../adminSession');
const { deleteShare } = require('../shareService');
const { resolveReport, getReport } = require('../reportService');
const { MAX_SHARE_ID_LENGTH } = require('../shareConstants');

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
  if (body == null || typeof body !== 'object') {
    res.status(400).json({ error: 'Request body must be a JSON object.' });
    return;
  }
  const { shareId, reportId } = body;
  if (typeof shareId !== 'string' || !shareId || shareId.length > MAX_SHARE_ID_LENGTH) {
    res.status(400).json({ error: 'A valid shareId is required.' });
    return;
  }
  if (reportId !== undefined && (typeof reportId !== 'string' || !reportId)) {
    res.status(400).json({ error: 'reportId, if provided, must be a non-empty string.' });
    return;
  }

  try {
    const deleted = await deleteShare(shareId);
    if (reportId) {
      const report = await getReport(reportId);
      if (report && report.shareId === shareId) {
        await resolveReport(reportId);
      }
    }
    res.status(200).json({ ok: true, deleted });
  } catch (err) {
    console.error('admin-ui takedown failed:', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Could not complete takedown.' });
  }
};
