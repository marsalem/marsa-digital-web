// api/admin-ui/[action].js
// Marsa Digital web — the SOLE Vercel Function serving all six admin
// moderation UI endpoints. Previously six separate function files under
// api/admin-ui/ (one per endpoint); consolidated into this single
// dynamic-segment route specifically to stay under the Hobby plan's
// 12-Serverless-Function-per-deployment cap — adding the dashboard's six
// routes as separate functions pushed the project to 15; this brings it
// back to 10 (see the implementation plan for the exact count).
//
// Same zero-config dynamic-segment mechanism already proven live in this
// project by api/share/[id].js — no vercel.json changes needed. Vercel
// matches the single path segment after /api/admin-ui/ and exposes it
// as req.query.action. All six public URLs are UNCHANGED:
//   /api/admin-ui/login, /logout, /reports, /dismiss-report, /takedown,
//   /block-creator — quran-atlas/admin.html's own fetch calls are
//   untouched by this refactor, and need no changes.
//
// WHY THIS IS SAFE — every one of the six handlers below is REQUIRED
// from lib/adminUiHandlers/, NOT reimplemented. Moving them out of api/
// (so Vercel stops counting them as separate functions — confirmed via
// Vercel's own current docs: "Keep...shared utilities outside the root
// api/ directory because Vercel deploys each supported source file
// there as a separate function") changed nothing about their own logic:
// each still carries its own HTTP-method check, session/CSRF guard,
// rate limiter, request validation, and error handling, byte-for-byte
// as before this refactor — this file is a pure routing shim with zero
// business logic of its own.
//
// STRICT ALLOWLIST — ACTIONS is built with Object.create(null)
// specifically so an action value like "constructor"/"__proto__"/
// "toString" can never resolve to an inherited Object.prototype member
// instead of a real handler (a plain {} would let `action: "constructor"`
// resolve to the Object constructor itself — callable, but not a 404,
// and not any of the six real handlers either). Dispatch happens ONLY
// through this fixed table; anything not in it is a 404, never a
// fallthrough to any handler, and the response never includes the
// internal module path, file structure, or any stack trace — only the
// same generic `{ error: 'Not found.' }` shape every other 4xx in this
// codebase already uses.

const loginHandler = require('../../lib/adminUiHandlers/login.js');
const logoutHandler = require('../../lib/adminUiHandlers/logout.js');
const reportsHandler = require('../../lib/adminUiHandlers/reports.js');
const dismissReportHandler = require('../../lib/adminUiHandlers/dismiss-report.js');
const takedownHandler = require('../../lib/adminUiHandlers/takedown.js');
const blockCreatorHandler = require('../../lib/adminUiHandlers/block-creator.js');

const ACTIONS = Object.assign(Object.create(null), {
  login: loginHandler,
  logout: logoutHandler,
  reports: reportsHandler,
  'dismiss-report': dismissReportHandler,
  takedown: takedownHandler,
  'block-creator': blockCreatorHandler,
});

module.exports = async function handler(req, res) {
  const { action } = req.query;
  const target = typeof action === 'string' ? ACTIONS[action] : undefined;

  if (typeof target !== 'function') {
    res.status(404).json({ error: 'Not found.' });
    return;
  }

  // HTTP-method validation is intentionally NOT duplicated here — each
  // handler already enforces its own expected method (GET for reports,
  // POST for the other five) and returns its own 405, exactly as before
  // this refactor. Re-checking it here would be a second, parallel copy
  // of logic that already exists once, in one place, already tested.
  return target(req, res);
};
