"use strict";

/**
 * 0006 — email verification.
 *
 * Adds:
 *   - users.email_verified_at (INTEGER, nullable) — timestamp of the
 *     last successful verification click. NULL means "email present
 *     but unproven". We reset to NULL whenever the address itself
 *     changes (users can't keep a proven-verified flag against a
 *     value they've since swapped out).
 *
 *   - email_verification_tokens — mirror-image of the existing
 *     password_reset_tokens table. One pending token per user at a
 *     time (invalidated on issue); 24-hour TTL; stores the exact
 *     email address being claimed so a later profile edit doesn't
 *     accidentally auto-verify a different address.
 *
 * The column default of NULL (not 0) is deliberate: every existing
 * row's email should be treated as "has not yet proven ownership",
 * not "proven at timestamp 0". The unverified branch of the auth
 * code uses `email_verified_at IS NULL` everywhere.
 */

module.exports = {
  id: "0006_email_verification",
  up(db, { tableHasColumn }) {
    if (!tableHasColumn(db, "users", "email_verified_at")) {
      db.exec(
        `ALTER TABLE users ADD COLUMN email_verified_at INTEGER DEFAULT NULL`
      );
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS email_verification_tokens (
        token      TEXT PRIMARY KEY,
        username   TEXT NOT NULL,
        email      TEXT NOT NULL,
        issued_at  INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at    INTEGER DEFAULT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_evt_username
        ON email_verification_tokens (username);
      CREATE INDEX IF NOT EXISTS idx_evt_expires_at
        ON email_verification_tokens (expires_at);
    `);
  },
};
