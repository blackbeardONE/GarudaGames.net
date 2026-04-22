"use strict";

/**
 * Password reset tokens. Admin generates a one-shot token from the admin
 * console (or curl); user redeems it at /forgot-password.html to set a
 * new password. Token is 256 bits of randomness, default TTL 24h, single
 * use. No email dependency — admin shares the token out-of-band
 * (Discord DM, SMS, in-person …).
 */
module.exports = {
  id: "0004_password_reset_tokens",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        token       TEXT PRIMARY KEY,
        username    TEXT NOT NULL,
        issued_by   TEXT NOT NULL,
        issued_at   INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        used_at     INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_prt_username
        ON password_reset_tokens (username);
      CREATE INDEX IF NOT EXISTS idx_prt_expires
        ON password_reset_tokens (expires_at);
    `);
  },
};
