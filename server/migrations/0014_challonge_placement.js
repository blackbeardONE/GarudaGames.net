"use strict";

/**
 * 0014 — Challonge participant auto-placement (v1.27.0).
 *
 * Extends the v1.26 Challonge infrastructure so the server can match
 * the submitting member against the bracket's participant list and
 * record a server-verified placement, not just a server-verified
 * participant count.
 *
 * Adds:
 *   challonge_cache.participants_json — JSON array
 *       [{ name, finalRank }]. Null/empty for tournaments fetched
 *       via the v1.26 unauthenticated path or for tournaments whose
 *       state is not `complete`. Bounded to 32 KB in server code.
 *
 *   achievements.placement_verified — 0/1 flag. Set to 1 at ingest
 *       iff the member's IGN (club-tag prefix stripped) matches
 *       exactly one participant AND the submitted placement equals
 *       that participant's `final_rank`. Drives the upgraded
 *       "Challonge-verified placement" pill on the portfolio /
 *       dashboard.
 *
 *   achievements.verified_ign — the name on the bracket that the
 *       server matched. Stored verbatim (clipped to 64 chars) so a
 *       verifier or admin can see who the system lined the row up
 *       against. Empty for rows that aren't placement-verified.
 *
 * Why separate columns vs JSON blob: these are the two fields the
 * UI, audit, and future reports read; keeping them as typed columns
 * lets us index them cheaply and keep the achievement schema legible.
 */

module.exports = {
  id: "0014_challonge_placement",
  up(db, { tableHasColumn }) {
    if (!tableHasColumn(db, "challonge_cache", "participants_json")) {
      db.exec(
        `ALTER TABLE challonge_cache
           ADD COLUMN participants_json TEXT NOT NULL DEFAULT ''`
      );
    }
    if (!tableHasColumn(db, "achievements", "placement_verified")) {
      db.exec(
        `ALTER TABLE achievements
           ADD COLUMN placement_verified INTEGER NOT NULL DEFAULT 0`
      );
    }
    if (!tableHasColumn(db, "achievements", "verified_ign")) {
      db.exec(
        `ALTER TABLE achievements
           ADD COLUMN verified_ign TEXT NOT NULL DEFAULT ''`
      );
    }
  },
};
