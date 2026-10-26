// api/admin/takedown.js
// Marsa Digital web — POST /api/admin/takedown: disable a shared link.
// Admin-only (lib/adminAuth.js). Finally wires up shareService's own
// deleteShare — defined since this service's first version, never
// reachable from a route until now (see shareService.js's own comment on
// why it was kept, unused, for exactly this). Works identically for ANY
// shareId regardless of when it was created (deleteShare is a plain
// Redis DEL by key, with no assumption about the share's own age/shape)
// — "works for existing shares as well as future ones" is true by
// construction, not by special-casing.
//
// Body: { shareId: string, reportId?: string }. If reportId is provided,
// that report is also marked resolved in the same call — a convenience
// for the common "I reviewed this report and I'm taking the content
// down" path, not a requirement (shareId alone is enough to take
// something down that was never formally reported, e.g. spotted
// directly or reported via the support inbox instead of the in-app
// flow).

const { rejectUnlessAdmin } = require('../../lib/adminAuth');
const { checkAdminRateLimit } = require('../../lib/rateLimit');
const { deleteShare } = require('../../lib/shareService');
const { resolveReport, getReport } = require('../../lib/reportService');
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
      // Only resolve a report that actually references the shareId being
      // taken down — a mismatched reportId/shareId pair is a caller
      // mistake, not something to silently paper over by resolving the
      // wrong report.
      if (report && report.shareId === shareId) {
        await resolveReport(reportId);
      }
    }
    res.status(200).json({ ok: true, deleted });
  } catch (err) {
    console.error('takedown failed:', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Could not complete takedown.' });
  }
};
