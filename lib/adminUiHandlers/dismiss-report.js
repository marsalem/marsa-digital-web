// lib/adminUiHandlers/dismiss-report.js
// Relocated from api/admin-ui/dismiss-report.js — now required by
// api/admin-ui/[action].js (see that file's own header) rather than
// deployed as its own Vercel Function. Logic and security checks below
// are unchanged by the move.
//
// Marsa Digital web — POST /api/admin-ui/dismiss-report: mark a report
// resolved WITHOUT taking down its content. Session-cookie + CSRF-header
// gated (see lib/adminSession.js) — the Bearer-token equivalent,
// api/admin/dismiss-report.js, is untouched; this calls the same
// lib/reportService.js function directly.
//
// Body: { reportId: string }.

const { checkAdminRateLimit } = require('../rateLimit');
const { rejectUnlessValidSession, rejectUnlessSameOriginHeader } = require('../adminSession');
const { resolveReport } = require('../reportService');

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
  const reportId = body && typeof body === 'object' ? body.reportId : undefined;
  if (typeof reportId !== 'string' || !reportId) {
    res.status(400).json({ error: 'A valid reportId is required.' });
    return;
  }

  try {
    await resolveReport(reportId);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('admin-ui dismissReport failed:', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Could not dismiss report.' });
  }
};
