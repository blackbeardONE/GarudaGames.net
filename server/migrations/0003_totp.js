"use strict";

/**
 * Add TOTP (2FA) columns to users. Secret is base32 (RFC 4648), 32 chars.
 * `totp_enabled` is the gate — a row can have a secret that isn't in
 * effect yet (setup started but verify not yet confirmed).
 *
 * Idempotent: ALTERs are column-guarded.
 */
module.exports = {
  id: "0003_totp",
  up(db, { tableHasColumn }) {
    if (!tableHasColumn(db, "users", "totp_secret")) {
      db.exec(
        `ALTER TABLE users
           ADD COLUMN totp_secret TEXT NOT NULL DEFAULT ''`
      );
    }
    if (!tableHasColumn(db, "users", "totp_enabled")) {
      db.exec(
        `ALTER TABLE users
           ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0`
      );
    }
  },
};
