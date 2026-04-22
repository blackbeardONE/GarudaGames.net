"use strict";

/**
 * Multi-game PRO flags: add pro_games_json to users + id_flag_requests and
 * backfill from the legacy professional_blader boolean. Canonical source
 * is the array; the boolean is kept in sync downstream so older queries
 * still work.
 *
 * Idempotent: ALTERs are column-guarded, backfills only touch rows where
 * the new column is still empty ("" or "[]").
 */
module.exports = {
  id: "0002_pro_games_json",
  up(db, { tableHasColumn }) {
    if (!tableHasColumn(db, "users", "pro_games_json")) {
      db.exec(
        `ALTER TABLE users
           ADD COLUMN pro_games_json TEXT NOT NULL DEFAULT '[]'`
      );
    }
    db.prepare(
      `UPDATE users
          SET pro_games_json = '["Beyblade X"]'
        WHERE professional_blader = 1
          AND (pro_games_json = '' OR pro_games_json = '[]')`
    ).run();

    if (!tableHasColumn(db, "id_flag_requests", "pro_games_json")) {
      db.exec(
        `ALTER TABLE id_flag_requests
           ADD COLUMN pro_games_json TEXT NOT NULL DEFAULT '[]'`
      );
    }
    db.prepare(
      `UPDATE id_flag_requests
          SET pro_games_json = '["Beyblade X"]'
        WHERE professional_blader = 1
          AND (pro_games_json = '' OR pro_games_json = '[]')`
    ).run();
  },
};
