"use strict";

/**
 * 0009 — Per-game evidence for ID flag requests (v1.14.0).
 *
 * Before this release the flag review flow was essentially a trust
 * exercise: a user ticked "Professional Blader" (or one of the newer
 * per-game pills from v1.3.1) and a Verifier either believed them or
 * didn't. That worked while the only professional pill was Beyblade X
 * and everyone in the queue was personally known to the reviewer, but
 * with seven pro games live the claim surface is too wide for that.
 *
 * v1.14.0 moves to a "show, don't tell" model. Every newly-requested
 * PRO pill must arrive with evidence:
 *
 *   - PRO Beyblade X   -> a named league (PBBL, XT, or XV) plus a
 *                         photo from the event OR a Challonge link
 *                         for the bracket they played in.
 *   - PRO <esports>    -> a photo or a social-media post link
 *                         (Facebook, X, Instagram, TikTok, YouTube)
 *                         showing you represented that game at a
 *                         recognised event.
 *
 * Certified Judge is NOT requested through this table anymore; a
 * JLAP submission approval auto-grants the Judge flag (see
 * PATCH /api/jlap/:id). Users can still downgrade themselves to
 * non-judge through /api/id-flags/request without evidence.
 *
 * Schema notes:
 *   - id            uid, surfaced in the verifier UI so a reviewer can
 *                   reference a specific photo in their note.
 *   - request_id    FK to id_flag_requests(id); CASCADEs on delete so
 *                   when a user is deleted (users ON DELETE CASCADE
 *                   reaches id_flag_requests, which now reaches here)
 *                   nothing is left behind.
 *   - game          one of the seven ALLOWED_GAMES names. Kept as
 *                   plain text so a future game addition doesn't need
 *                   a schema change.
 *   - league        enum-ish text: "PBBL" | "XT" | "XV" | "" .
 *                   Only populated for Beyblade X evidence.
 *   - photo_data_url  base64 data URL, capped by the existing
 *                     MAX_POSTER_URL guard at the API layer. NOT
 *                     NULL DEFAULT '' so rows can carry only a link.
 *   - link_url      Challonge URL (Beyblade X) or social post URL
 *                   (esports). Capped by the existing MAX_URL guard
 *                   at the API layer. NOT NULL DEFAULT '' so rows
 *                   can carry only a photo.
 *   - note          optional free-text from the submitter ("semis,
 *                   court 3"). Capped at 500 chars server-side.
 *   - created_at    ms since epoch.
 *
 * Index: (request_id) for the verifier queue, which always fetches
 * evidence by the owning request id.
 */

module.exports = {
  id: "0009_id_flag_evidence",
  up(db /* , { tableHasColumn } */) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS id_flag_evidence (
        id             TEXT PRIMARY KEY,
        request_id     TEXT NOT NULL,
        game           TEXT NOT NULL,
        league         TEXT NOT NULL DEFAULT '',
        photo_data_url TEXT NOT NULL DEFAULT '',
        link_url       TEXT NOT NULL DEFAULT '',
        note           TEXT NOT NULL DEFAULT '',
        created_at     INTEGER NOT NULL,
        FOREIGN KEY (request_id) REFERENCES id_flag_requests (id)
          ON UPDATE CASCADE ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_idfe_request
        ON id_flag_evidence (request_id);
    `);
  },
};
