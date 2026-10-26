// api/admin/dismiss-report.js
// Marsa Digital web — POST /api/admin/dismiss-report: mark a report
// resolved WITHOUT taking down its content (investigated, found not
// actionable). Admin-only. Kept as a separate action from takedown
// (api/admin/takedown.js) rather than an implicit side effect of it, so
// "I looked at this and it's fine" and "I looked at this and removed it"
// are two distinct, explicit operator decisions — never auto-bundled.
//
// Body: { reportId: string }.

const { rejectUnlessAdmin } = require('../../lib/adminAuth');
const { checkAdminRateLimit } = require('../../lib/rateLimit');
const { resolveReport } = require('../../lib/reportService');

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
  const reportId = body && typeof body === 'object' ? body.reportId : undefined;
  if (typeof reportId !== 'string' || !reportId) {
    res.status(400).json({ error: 'A valid reportId is required.' });
    return;
  }

  try {
    await resolveReport(reportId);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('dismissReport failed:', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Could not dismiss report.' });
  }
};
