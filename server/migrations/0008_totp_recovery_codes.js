"use strict";

/**
 * 0008 — TOTP recovery codes (v1.12.0).
 *
 * The v1.7–v1.11 2FA flow has exactly one failure mode: if the member
 * loses access to their authenticator (lost phone, wiped device, broken
 * app), the ONLY recovery path is an admin hitting
 * /api/admin/members/:u/2fa/disable. That is slow (ops has to be
 * available), fragile (the member has to prove identity on Discord),
 * and actively discourages members from turning 2FA on in the first
 * place.
 *
 * Recovery codes fix that: at 2FA setup time we mint ten single-use
 * codes, show them to the member once, and store only SHA-256 hashes.
 * The login flow accepts EITHER a 6-digit TOTP code OR one of the
 * stored recovery codes, burning the latter on use. Disabling 2FA (or
 * deleting the account) cascades and wipes every unused code.
 *
 * Columns:
 *   - id         uid, for admin-side audit references (never surfaced
 *                to members — they see the printed code, not this).
 *   - username   owner, COLLATE NOCASE for consistent joins.
 *   - code_hash  hex(sha256(code)). SHA-256 is fine here (80-bit
 *                random plaintexts rule out dictionary attacks on the
 *                hash); scrypt would be overkill and would slow every
 *                login with a recovery code attempt to ~100ms.
 *   - issued_at  ms since epoch, when the code was created.
 *   - used_at    ms since epoch when the code was redeemed. NULL
 *                means unused. We keep used rows for forensic visibility
 *                in the admin security panel (v1.13.0); they get
 *                scrubbed when 2FA is disabled or the user is deleted.
 *
 * FK + indexes: username references users(username) with ON DELETE
 * CASCADE so account deletion does the right thing. A partial index
 * on (username) WHERE used_at IS NULL keeps the "does this hash match
 * an unused code for this user?" lookup cheap even if a member
 * accumulates a dozen regenerate cycles of history.
 */

module.exports = {
  id: "0008_totp_recovery_codes",
  up(db /* , { tableHasColumn } */) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS totp_recovery_codes (
        id         TEXT PRIMARY KEY,
        username   TEXT NOT NULL COLLATE NOCASE,
        code_hash  TEXT NOT NULL,
        issued_at  INTEGER NOT NULL,
        used_at    INTEGER DEFAULT NULL,
        FOREIGN KEY (username) REFERENCES users (username)
          ON UPDATE CASCADE ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_trc_username
        ON totp_recovery_codes (username);
      CREATE INDEX IF NOT EXISTS idx_trc_active
        ON totp_recovery_codes (username, code_hash) WHERE used_at IS NULL;
    `);
  },
};
