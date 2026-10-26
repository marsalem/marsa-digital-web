// lib/reportService.js
// Marsa Digital web — storage for user-submitted reports against a
// specific shareId, and the open/resolved tracking an operator (you)
// needs to actually act on them. Reuses the SAME Upstash Redis instance
// every other module in this backend already talks to — no new
// infrastructure.
//
// DATA MODEL:
//   report:<reportId>   — JSON {reportId, shareId, reason, details,
//                          createdAt}, immutable once written, TTL =
//                          REPORT_TTL_SECONDS.
//   reports:open        — Redis LIST of reportIds awaiting review
//                          (RPUSH on create, LREM on resolve). This list
//                          membership, not a mutable status field inside
//                          the report record itself, is what "open" vs.
//                          "resolved" means — avoids ever needing to
//                          rewrite a stored report (which would also
//                          raise a TTL-preservation question this design
//                          sidesteps entirely).
//   reports:resolved     — Redis LIST of reportIds that have been
//                          reviewed (RPUSH on resolve), trimmed to the
//                          most recent 500 — a lightweight audit trail,
//                          not a queryable archive. The actual report
//                          content for a resolved report is still
//                          reachable via report:<reportId> for as long as
//                          its own TTL lasts.
//
// MINIMUM INFORMATION: no reporter email, name, device identifier, or IP
// address is ever stored in a report record — only what's needed to
// identify and act on the share (shareId, reason, optional free-text
// details). The rate limiter (lib/rateLimit.js) sees the reporter's IP
// transiently to enforce its own limit, but that's Upstash's own
// sliding-window bookkeeping, never written into a report record here.
//
// LOGGING DISCIPLINE — never log `details` (reporter-written free text)
// or the reported share's own content; shareId/reason/reportId/timestamps
// are fine (they identify a report, not expose content).

const crypto = require('crypto');
const { getRedisClient } = require('./redisClient');
const { REPORT_TTL_SECONDS } = require('./shareConstants');

const redis = getRedisClient();

const REPORT_KEY_PREFIX = 'report:';
const OPEN_LIST_KEY = 'reports:open';
const RESOLVED_LIST_KEY = 'reports:resolved';
const RESOLVED_LIST_MAX = 500;

function generateReportId() {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * @param {{ shareId: string, reason: string, details?: string }} input
 * @returns {Promise<{ reportId: string }>}
 */
async function createReport({ shareId, reason, details }) {
  const reportId = generateReportId();
  const record = {
    reportId,
    shareId,
    reason,
    details: details || '',
    createdAt: Date.now(),
  };
  await redis.set(REPORT_KEY_PREFIX + reportId, JSON.stringify(record), { ex: REPORT_TTL_SECONDS });
  await redis.rpush(OPEN_LIST_KEY, reportId);
  return { reportId };
}

/**
 * Returns every currently-open report, skipping any reportId whose own
 * record has already expired (its TTL lapsed before anyone resolved it —
 * treated as "nothing left to review," not an error).
 * @returns {Promise<Array<{reportId: string, shareId: string, reason: string, details: string, createdAt: number}>>}
 */
async function listOpenReports() {
  const ids = await redis.lrange(OPEN_LIST_KEY, 0, -1);
  const reports = [];
  for (const reportId of ids) {
    const raw = await redis.get(REPORT_KEY_PREFIX + reportId);
    if (raw == null) continue;
    reports.push(typeof raw === 'string' ? JSON.parse(raw) : raw);
  }
  return reports;
}

/**
 * Fetches a single report by id, or null if it doesn't exist / expired.
 * @param {string} reportId
 * @returns {Promise<{reportId: string, shareId: string, reason: string, details: string, createdAt: number} | null>}
 */
async function getReport(reportId) {
  const raw = await redis.get(REPORT_KEY_PREFIX + reportId);
  if (raw == null) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/**
 * Marks a report resolved — removes it from the open list and appends it
 * to the (trimmed) resolved audit list. Idempotent: resolving an already-
 * resolved or nonexistent reportId is a harmless no-op, not an error,
 * since an admin retrying a call after a network hiccup shouldn't need to
 * know which outcome actually happened first.
 * @param {string} reportId
 * @returns {Promise<void>}
 */
async function resolveReport(reportId) {
  await redis.lrem(OPEN_LIST_KEY, 0, reportId);
  await redis.rpush(RESOLVED_LIST_KEY, reportId);
  await redis.ltrim(RESOLVED_LIST_KEY, -RESOLVED_LIST_MAX, -1);
}

module.exports = { createReport, listOpenReports, getReport, resolveReport };
