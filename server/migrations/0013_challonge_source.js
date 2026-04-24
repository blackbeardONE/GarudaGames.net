"use strict";

/**
 * 0013 — Challonge bracket attribution + response cache (v1.26.0).
 *
 * Adds:
 *   achievements.source — 'manual' (default, matches every pre-v1.26
 *                          row) or 'challonge'. Set at ingest when the
 *                          member pasted a challonge.com URL AND the
 *                          server's preview fetch succeeded for it.
 *                          Drives the "Verified from Challonge" pill
 *                          on the portfolio + dashboard.
 *
 *   challonge_cache    — normalized tournament snapshots keyed by
 *                          URL hash. 24-hour TTL. The preview endpoint
 *                          writes here; the ingest path reads here to
 *                          confirm a fresh preview exists for the URL
 *                          before stamping source='challonge'. No PII.
 *
 * Why separate cache table (vs a column on achievements):
 *   - A tournament can be referenced by dozens of achievements (one
 *     per placing member). Caching per-URL deduplicates the
 *     outbound fetch load.
 *   - We want the cache to survive achievement deletions so
 *     re-submissions don't re-fetch.
 */

module.exports = {
  id: "0013_challonge_source",
  up(db, { tableHasColumn }) {
    if (!tableHasColumn(db, "achievements", "source")) {
      db.exec(
        `ALTER TABLE achievements ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`
      );
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS challonge_cache (
        url_sha256 TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        tournament_name TEXT NOT NULL DEFAULT '',
        participants_count INTEGER NOT NULL DEFAULT 0,
        completed_at_iso TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT '',
        raw_json TEXT NOT NULL DEFAULT '',
        fetched_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_challonge_cache_fetched
        ON challonge_cache(fetched_at);
    `);
  },
};
