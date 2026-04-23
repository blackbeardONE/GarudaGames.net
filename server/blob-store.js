"use strict";

/**
 * Content-addressed blob store (v1.23.0).
 *
 * Why this exists:
 *   Images live inside SQLite as base64 `data:image/...` columns since
 *   launch. That's operationally friendly (one file, transactional
 *   writes) but makes every list endpoint fat. /api/leaderboard is
 *   already ~2 MB at ~100 members, dominated by inline avatars that
 *   the v1.21 cache can only serve — not shrink.
 *
 * Design:
 *   - Content-addressed on disk: `<BLOB_DIR>/<sha[0:2]>/<sha>.<ext>`.
 *     Two users uploading the same image share one file for free.
 *   - Registry in SQLite (`blobs` table): sha256 PK + mime + size +
 *     created_at. Not a replacement for the files on disk, a pointer.
 *   - Mime-allowlist: we only accept image/jpeg|png|webp|gif|svg+xml.
 *     Anything else is rejected at ingest. No HTML, no PDF, no script.
 *   - No refcount column. `gcOrphans()` walks every host row,
 *     computes the in-use set, and deletes everything else. Runs at
 *     deploy time on demand (`server/gc-blobs.js`), robust to SQLite
 *     cascade deletes that we can't hook from JS.
 *   - Idempotent: `putBlobFromDataUrl` on the same bytes returns the
 *     existing metadata and never rewrites the file; re-running the
 *     backfill is safe.
 *
 * Paths:
 *   GARUDA_BLOB_DIR env var overrides the default, which is
 *   `<GARUDA_DATA_DIR>/blobs` (so tests scoped to a tmpdir DB also
 *   get a tmpdir blob store — nothing leaks into /var/lib).
 *
 * Permissions:
 *   Directory and files created 0700 / 0600 — same posture as the
 *   SQLite DB. The process runs as `garuda-app`; nginx never touches
 *   these files directly, the /api/blob endpoint streams them through
 *   express.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { db } = require("./db");

const BLOB_DIR =
  process.env.GARUDA_BLOB_DIR ||
  path.join(
    process.env.GARUDA_DATA_DIR || path.join(__dirname, "data"),
    "blobs"
  );

// Extensions we are willing to write to disk. Keeping this list short
// (and image-only) is deliberate: the blob endpoint serves whatever
// mime we stored here, so a surprise `text/html` entry would be an
// open redirect / XSS vector. New mimes require a code change.
const MIME_EXT = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

function ensureBlobDir() {
  try {
    if (!fs.existsSync(BLOB_DIR)) {
      fs.mkdirSync(BLOB_DIR, { recursive: true, mode: 0o700 });
    }
  } catch (_) {
    // Surface the error lazily on the first put/get — boot should not
    // fail because of a missing blob dir, since a read-only diagnostic
    // run (probe.sh) might still want to open the DB.
  }
}
ensureBlobDir();

function pathForBlob(sha256, mime) {
  const ext = MIME_EXT[mime] || "bin";
  return path.join(BLOB_DIR, sha256.slice(0, 2), sha256 + "." + ext);
}

/**
 * Parse a `data:<mime>;base64,<payload>` string into `{ mime, buf }`.
 * Returns null for anything that isn't a base64 data URL of an
 * allowlisted mime type.
 */
function parseDataUrl(s) {
  if (typeof s !== "string" || s.length < 20) return null;
  if (!s.startsWith("data:")) return null;
  const comma = s.indexOf(",");
  if (comma < 0) return null;
  const meta = s.slice(5, comma).toLowerCase();
  const parts = meta.split(";").map((p) => p.trim());
  const mime = parts[0] || "";
  if (!MIME_EXT[mime]) return null;
  if (!parts.includes("base64")) return null;
  let buf;
  try {
    buf = Buffer.from(s.slice(comma + 1), "base64");
  } catch (_) {
    return null;
  }
  if (!buf.length) return null;
  return { mime, buf };
}

/**
 * Accept a data URL, hash, write to disk (if new), upsert into
 * `blobs`. Returns `{ sha256, mime, size }` or null if the input
 * was not a valid allowlisted data URL.
 */
function putBlobFromDataUrl(dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;
  const sha = crypto.createHash("sha256").update(parsed.buf).digest("hex");
  const existing = db
    .prepare("SELECT sha256, mime, size FROM blobs WHERE sha256 = ?")
    .get(sha);
  const p = pathForBlob(sha, parsed.mime);
  // If a DB row exists but the file is missing (e.g. a rsync that
  // clobbered the blobs/ dir), restore the file from the buffer we
  // just decoded. Same bytes = same sha, so this is safe.
  if (!existing) {
    ensureBlobDir();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, parsed.buf, { mode: 0o600 });
    db.prepare(
      "INSERT INTO blobs (sha256, mime, size, created_at) VALUES (?, ?, ?, ?)"
    ).run(sha, parsed.mime, parsed.buf.length, Date.now());
  } else if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, parsed.buf, { mode: 0o600 });
  }
  return { sha256: sha, mime: parsed.mime, size: parsed.buf.length };
}

function getBlobMeta(sha256) {
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
    return null;
  }
  return (
    db
      .prepare("SELECT sha256, mime, size FROM blobs WHERE sha256 = ?")
      .get(sha256) || null
  );
}

/**
 * Find the on-disk file for a sha256. Returns null if the registry
 * doesn't know it, OR if the file was deleted out from under us
 * (returns null so the caller can 404 cleanly rather than throwing).
 */
function getBlobPath(sha256) {
  const meta = getBlobMeta(sha256);
  if (!meta) return null;
  const p = pathForBlob(meta.sha256, meta.mime);
  if (!fs.existsSync(p)) return null;
  return { path: p, sha256: meta.sha256, mime: meta.mime, size: meta.size };
}

/**
 * Count references to a sha256 across every host table. Zero means
 * the blob is an orphan and GC can reclaim it.
 */
function countRefs(sha256) {
  return (
    db.prepare("SELECT COUNT(*) AS c FROM users WHERE photo_sha256 = ?").get(
      sha256
    ).c +
    db
      .prepare("SELECT COUNT(*) AS c FROM achievements WHERE poster_sha256 = ?")
      .get(sha256).c +
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM jlap_submissions WHERE certificate_sha256 = ?"
      )
      .get(sha256).c +
    db
      .prepare("SELECT COUNT(*) AS c FROM jlap_submissions WHERE qr_sha256 = ?")
      .get(sha256).c +
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM id_flag_evidence WHERE photo_sha256 = ?"
      )
      .get(sha256).c
  );
}

/**
 * If no host row references `sha256`, delete the file and the
 * registry row. Returns true if something was deleted.
 */
function deleteBlobIfOrphan(sha256) {
  if (countRefs(sha256) > 0) return false;
  const meta = getBlobMeta(sha256);
  if (!meta) return false;
  const p = pathForBlob(meta.sha256, meta.mime);
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) {
    // File deletion is best-effort — rerunning GC will retry.
  }
  db.prepare("DELETE FROM blobs WHERE sha256 = ?").run(sha256);
  return true;
}

function gcOrphans({ logger } = {}) {
  const all = db.prepare("SELECT sha256 FROM blobs").all();
  let deleted = 0;
  for (const row of all) {
    if (deleteBlobIfOrphan(row.sha256)) {
      deleted++;
      if (logger) logger("gc: deleted orphan " + row.sha256.slice(0, 16));
    }
  }
  return deleted;
}

/**
 * Auth model for /api/blob/:sha256. Deliberately non-enumerable:
 *   - Public if ANY public reference exists (user photo or verified
 *     achievement poster). These are already exposed verbatim from
 *     /api/leaderboard and /api/members.
 *   - Authenticated owner access if a host row references the blob
 *     AND owning user matches req.user.
 *   - Staff (verifier | admin) access for every non-public ref.
 *   - Otherwise 403.
 *
 * Returns `{ ok: boolean, public: boolean }`. The `public` flag is
 * consumed by the endpoint to pick Cache-Control (public vs private).
 */
function canServeBlob(req, sha256) {
  if (
    db
      .prepare("SELECT 1 FROM users WHERE photo_sha256 = ? LIMIT 1")
      .get(sha256)
  ) {
    return { ok: true, public: true };
  }
  if (
    db
      .prepare(
        "SELECT 1 FROM achievements WHERE poster_sha256 = ? AND status = 'verified' LIMIT 1"
      )
      .get(sha256)
  ) {
    return { ok: true, public: true };
  }
  const u = req && req.user ? req.user : null;
  if (!u) return { ok: false, public: false };
  const isStaff = u.role === "verifier" || u.role === "admin";
  if (isStaff) {
    if (
      db
        .prepare(
          "SELECT 1 FROM achievements WHERE poster_sha256 = ? LIMIT 1"
        )
        .get(sha256)
    )
      return { ok: true, public: false };
    if (
      db
        .prepare(
          "SELECT 1 FROM jlap_submissions WHERE certificate_sha256 = ? OR qr_sha256 = ? LIMIT 1"
        )
        .get(sha256, sha256)
    )
      return { ok: true, public: false };
    if (
      db
        .prepare(
          "SELECT 1 FROM id_flag_evidence WHERE photo_sha256 = ? LIMIT 1"
        )
        .get(sha256)
    )
      return { ok: true, public: false };
  }
  if (
    db
      .prepare(
        "SELECT 1 FROM achievements WHERE poster_sha256 = ? AND username = ? LIMIT 1"
      )
      .get(sha256, u.username)
  )
    return { ok: true, public: false };
  if (
    db
      .prepare(
        "SELECT 1 FROM jlap_submissions WHERE (certificate_sha256 = ? OR qr_sha256 = ?) AND username = ? LIMIT 1"
      )
      .get(sha256, sha256, u.username)
  )
    return { ok: true, public: false };
  if (
    db
      .prepare(
        `SELECT 1 FROM id_flag_evidence e
           JOIN id_flag_requests r ON r.id = e.request_id
          WHERE e.photo_sha256 = ? AND r.username = ? LIMIT 1`
      )
      .get(sha256, u.username)
  )
    return { ok: true, public: false };
  return { ok: false, public: false };
}

module.exports = {
  BLOB_DIR,
  MIME_EXT,
  parseDataUrl,
  pathForBlob,
  putBlobFromDataUrl,
  getBlobMeta,
  getBlobPath,
  countRefs,
  deleteBlobIfOrphan,
  gcOrphans,
  canServeBlob,
};
