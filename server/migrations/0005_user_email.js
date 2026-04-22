"use strict";

/**
 * 0005 — add `email` column + index for self-service password reset.
 *
 * The column is nullable (old rows won't have one) and NOT unique —
 * we specifically do NOT enforce uniqueness at the DB level because:
 *   1) People legitimately share addresses (siblings in the club).
 *   2) Enforcing it leaks whether an email is registered when a
 *      second account tries to use it.
 *
 * The index is non-unique and case-insensitive via COLLATE NOCASE so
 * the forgot-password lookup can do `WHERE email = ? COLLATE NOCASE`
 * without a full scan.
 */

module.exports = {
  id: "0005_user_email",
  up(db, { tableHasColumn }) {
    if (!tableHasColumn(db, "users", "email")) {
      db.exec(`ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''`);
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_users_email
         ON users (email COLLATE NOCASE)`
    );
  },
};
