"use strict";

/**
 * 0011 — Blob metadata + per-row sha256 columns (v1.23.0).
 *
 * Background
 * ----------
 * Since launch, every user-uploaded image has been stored as a base64
 * `data:image/...` string inside the host row:
 *   - `users.photo_data_url`          (profile avatar, cap 1.5 MB)
 *   - `achievements.poster_data_url`  (event poster, cap 2.5 MB)
 *   - `jlap_submissions.certificate_data_url` (cap 2.5 MB)
 *   - `jlap_submissions.qr_data_url`  (cap 1.0 MB)
 *   - `id_flag_evidence.photo_data_url` (cap 2.5 MB shared)
 *
 * That model is friendly at launch (one transactional unit, one
 * backup file) but it makes the "list" endpoints fat. At ~100 members
 * the /api/leaderboard JSON is already ~2 MB dominated by inline
 * avatars; every cache HIT we shipped in v1.21 still streams those
 * bytes over the wire. The 30s TTL cache only saves compute.
 *
 * v1.23.0 migrates to content-addressed on-disk storage:
 *   - New `blobs (sha256 PK, mime, size, created_at)` registry.
 *   - New `<host>.<field>_sha256 TEXT NOT NULL DEFAULT ''` columns on
 *     every table that currently owns a data URL.
 *   - Legacy `<field>_data_url` columns STAY. They remain the source
 *     of truth for any pre-v1.23 row until the one-shot backfill
 *     (`server/migrate-blobs-v123.js`) runs. After the backfill, new
 *     writes populate only the `_sha256` column and the API emits a
 *     short `<field>Url = "/api/blob/<sha256>"` instead of a huge
 *     inline data URL.
 *   - Blob files live at
 *     `<GARUDA_BLOB_DIR>/<first-2-hex>/<sha256>.<ext>` with the mime
 *     extension derived from `blobs.mime`. Shared storage across
 *     rows with identical bytes is free.
 *
 * We do NOT track refcounts here. `server/blob-store.js::gcOrphans()`
 * walks every host row, computes the set of in-use sha256s, and
 * deletes any `blobs` row + file that is no longer referenced. Much
 * simpler than maintaining counters through every INSERT/DELETE and
 * robust to cascade deletes that SQLite handles without our help.
 */

module.exports = {
  id: "0011_blob_metadata",
  up(db, { tableHasColumn }) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS blobs (
        sha256     TEXT PRIMARY KEY,
        mime       TEXT NOT NULL,
        size       INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    // Add *_sha256 columns without destroying any existing row. Guard
    // each ALTER with tableHasColumn so a fresh DB (where the baseline
    // CREATE TABLE in db.js has already been updated to include these
    // columns, if we ever do that) doesn't re-add them.
    const adds = [
      ["users", "photo_sha256"],
      ["achievements", "poster_sha256"],
      ["jlap_submissions", "certificate_sha256"],
      ["jlap_submissions", "qr_sha256"],
      ["id_flag_evidence", "photo_sha256"],
    ];
    for (const [table, col] of adds) {
      if (!tableHasColumn(db, table, col)) {
        db.exec(
          `ALTER TABLE ${table} ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`
        );
      }
    }

    // Lookup indexes to keep the GC sweep + /api/blob auth check fast
    // as the tables grow. Partial indexes on non-empty sha256 so we
    // don't index the default-empty rows until the backfill runs.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_users_photo_sha256
        ON users(photo_sha256) WHERE photo_sha256 != '';
      CREATE INDEX IF NOT EXISTS idx_ach_poster_sha256
        ON achievements(poster_sha256) WHERE poster_sha256 != '';
      CREATE INDEX IF NOT EXISTS idx_jlap_cert_sha256
        ON jlap_submissions(certificate_sha256) WHERE certificate_sha256 != '';
      CREATE INDEX IF NOT EXISTS idx_jlap_qr_sha256
        ON jlap_submissions(qr_sha256) WHERE qr_sha256 != '';
      CREATE INDEX IF NOT EXISTS idx_idfe_photo_sha256
        ON id_flag_evidence(photo_sha256) WHERE photo_sha256 != '';
    `);
  },
};
