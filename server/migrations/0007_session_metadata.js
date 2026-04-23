"use strict";

/**
 * 0007 — session metadata for the "active sessions" list (v1.9.0).
 *
 * The sessions table has lived as (id, username, created_at,
 * expires_at) since v1.0. That's enough to log someone in, but it
 * gives the member zero context when we ask them "is this list of
 * open sessions yours?" — the UI can only say "you have 3 sessions,
 * revoke them all?" which is scary and vague.
 *
 * This migration adds three fields, all nullable / empty-default so
 * every pre-existing row continues to validate:
 *
 *   - user_agent — raw UA string captured at login. Trimmed to 255
 *     chars on insertion to keep the table compact.
 *   - ip_address — remote address captured at login. Stored
 *     verbatim (IPv4 or IPv6); SECURITY.md §6 covers retention.
 *   - last_seen_at — timestamp of the most recent request that
 *     presented this cookie. Middleware debounces the write to
 *     roughly once-per-minute per session so chatty tabs don't
 *     hammer the DB.
 *
 * No backfill: historical rows get NULL/empty values and the UI
 * renders them as "unknown browser / unknown location" with the
 * original created_at for context.
 */

module.exports = {
  id: "0007_session_metadata",
  up(db, { tableHasColumn }) {
    if (!tableHasColumn(db, "sessions", "user_agent")) {
      db.exec(`ALTER TABLE sessions ADD COLUMN user_agent TEXT DEFAULT ''`);
    }
    if (!tableHasColumn(db, "sessions", "ip_address")) {
      db.exec(`ALTER TABLE sessions ADD COLUMN ip_address TEXT DEFAULT ''`);
    }
    if (!tableHasColumn(db, "sessions", "last_seen_at")) {
      db.exec(
        `ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER DEFAULT NULL`
      );
    }
  },
};
