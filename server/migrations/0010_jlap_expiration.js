"use strict";

/**
 * 0010 — JLAP expiration (v1.17.0).
 *
 * Real-world JLAP (Judge License And Proficiency) certifications run on
 * an annual cycle — a user who passed the exam last April is expected
 * to re-certify this April. Up to v1.16.0 the Certified Judge flag was
 * granted on JLAP approval and stayed forever: nothing on our side
 * tracked whether the underlying cert was still good, so a user whose
 * certificate lapsed a year ago kept running officiated brackets with
 * a green badge on their dashboard.
 *
 * This migration adds a nullable `expires_at` column to
 * `jlap_submissions`. The value is set by the Verifier at approval
 * time via `PATCH /api/jlap/:id` (optional — a null expires_at means
 * "indefinite" and preserves the old behaviour for pre-existing
 * rows). A nightly ops script (`server/expire-flags.js`) sweeps
 * expired rows, demotes the owner's `certified_judge` flag back to 0,
 * writes an audit row, and drops an inbox notification + email (the
 * user must pass v1.15's verified-email gate to see the email; we
 * still send the inbox row regardless).
 *
 * Column is nullable for two reasons:
 *   1. Legacy rows (pre-v1.17.0) don't have an expiry, and we don't
 *      want a one-off backfill to invent one on their behalf.
 *   2. Some approvals — bulk mass-certifications for founding
 *      judges, for instance — are policy-wise "until we say so";
 *      those stay null and never trip the sweeper.
 *
 * Idempotent: guarded by tableHasColumn so re-running is safe.
 */
module.exports = {
  id: "0010_jlap_expiration",
  up(db, { tableHasColumn }) {
    if (!tableHasColumn(db, "jlap_submissions", "expires_at")) {
      db.exec(
        `ALTER TABLE jlap_submissions
           ADD COLUMN expires_at INTEGER`
      );
    }
  },
};
