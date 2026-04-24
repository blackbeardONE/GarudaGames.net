"use strict";

/**
 * 0015 — Duplicate-poster tracking for poster-centric verification (v1.28.0).
 *
 * The Path-C strategy (after v1.27's API route turned out not to fit the
 * real-world TO privacy landscape) leans into the poster as the
 * authoritative placement artefact. That makes poster-copy fraud the
 * obvious attack vector to close: "member A's winning screenshot on
 * Apr 12; member B uploads the same PNG on Apr 18 claiming champ of a
 * different event." We already SHA-256 every poster (v1.23 blob store),
 * so detection is a single indexed lookup on ingest.
 *
 * Adds:
 *   achievements.duplicate_of — TEXT, default ''. When the row's
 *     poster_sha256 matched an existing (any user, any status)
 *     achievement at ingest time, we record that prior row's id here.
 *     The verifier queue surfaces this as a "Duplicate poster of <event>"
 *     badge so reviewers can eyeball the pair at a glance. We do NOT
 *     reject on duplicate — there are legitimate shared-poster cases
 *     (co-hosted events, cropped from the same stream overlay) — but
 *     verifiers always see the signal.
 *
 *   idx_achievements_poster_sha256 — a BTREE index on poster_sha256 so
 *     the ingest-time dupe lookup is O(log n) on the ~tens of thousands
 *     of achievement rows we expect to accumulate. Without the index,
 *     every submission would scan the whole table.
 */

module.exports = {
  id: "0015_duplicate_of",
  up(db, { tableHasColumn }) {
    if (!tableHasColumn(db, "achievements", "duplicate_of")) {
      db.exec(
        `ALTER TABLE achievements
           ADD COLUMN duplicate_of TEXT NOT NULL DEFAULT ''`
      );
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_achievements_poster_sha256
         ON achievements(poster_sha256)
        WHERE poster_sha256 <> ''`
    );
  },
};
