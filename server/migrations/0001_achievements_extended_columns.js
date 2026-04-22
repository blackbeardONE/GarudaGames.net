"use strict";

/**
 * Add the extended achievement columns that came in with the v1.0 → v1.2
 * scoring + game-categorisation work. Fresh installs get these from the
 * baseline CREATE TABLE in db.js; older installs pick them up here.
 * Idempotent: each ALTER is guarded by a tableHasColumn() check.
 */
module.exports = {
  id: "0001_achievements_extended_columns",
  up(db, { tableHasColumn }) {
    if (!tableHasColumn(db, "achievements", "rank_code")) {
      db.exec(
        `ALTER TABLE achievements
           ADD COLUMN rank_code TEXT NOT NULL DEFAULT ''`
      );
    }
    if (!tableHasColumn(db, "achievements", "placement")) {
      db.exec(
        `ALTER TABLE achievements
           ADD COLUMN placement INTEGER NOT NULL DEFAULT 0`
      );
    }
    if (!tableHasColumn(db, "achievements", "player_count")) {
      db.exec(
        `ALTER TABLE achievements
           ADD COLUMN player_count INTEGER NOT NULL DEFAULT 0`
      );
    }
    if (!tableHasColumn(db, "achievements", "game")) {
      db.exec(
        `ALTER TABLE achievements
           ADD COLUMN game TEXT NOT NULL DEFAULT 'Beyblade X'`
      );
    }
    if (!tableHasColumn(db, "achievements", "event_date")) {
      db.exec(
        `ALTER TABLE achievements
           ADD COLUMN event_date TEXT NOT NULL DEFAULT ''`
      );
    }
  },
};
