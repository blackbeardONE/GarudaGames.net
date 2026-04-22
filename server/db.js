"use strict";

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { runMigrations } = require("./migrations");

const DB_DIR = process.env.GARUDA_DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = path.join(DB_DIR, "garuda.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY COLLATE NOCASE,
  password_hash BLOB NOT NULL,
  password_salt BLOB NOT NULL,
  password_kdf TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  ign TEXT NOT NULL,
  real_name TEXT NOT NULL DEFAULT '',
  squad TEXT NOT NULL DEFAULT '',
  club_role TEXT NOT NULL DEFAULT 'Member',
  games_json TEXT NOT NULL DEFAULT '[]',
  photo_data_url TEXT NOT NULL DEFAULT '',
  certified_judge INTEGER NOT NULL DEFAULT 0,
  professional_blader INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS achievements (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE,
  event_name TEXT NOT NULL,
  rank TEXT NOT NULL,
  rank_points INTEGER NOT NULL DEFAULT 0,
  challonge_url TEXT NOT NULL DEFAULT '',
  poster_data_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  verifier_note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  verified_by TEXT,
  FOREIGN KEY(username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS jlap_submissions (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE,
  certificate_data_url TEXT NOT NULL DEFAULT '',
  qr_data_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  verifier_note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  verified_by TEXT,
  FOREIGN KEY(username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS id_flag_requests (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE,
  certified_judge INTEGER NOT NULL DEFAULT 0,
  professional_blader INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  verifier_note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  verified_by TEXT,
  FOREIGN KEY(username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS site_custom (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

-- Append-only admin/verifier activity log. Each row captures who did what to whom.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  ip TEXT,
  created_at INTEGER NOT NULL
);

-- Per-IP / per-user login attempt counter used for progressive lockout on top
-- of the express-rate-limit IP bucket.
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  success INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_key_time ON login_attempts(key, created_at);

-- Per-user in-app notifications inbox. Written by verification/moderation
-- endpoints; read by the dashboard.
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  read_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(username) REFERENCES users(username) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_time ON notifications(username, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(username, read_at);

-- Public "What's new" feed. Admin-authored, user-friendly release notes and
-- announcements. Read by news.html for every visitor; written by admin via
-- /api/admin/news. Rows with published = 0 are hidden from the public feed.
CREATE TABLE IF NOT EXISTS news_posts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'update',
  version TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  pinned INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_news_published_created
  ON news_posts(published, pinned DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username);
CREATE INDEX IF NOT EXISTS idx_ach_status_created ON achievements(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jlap_status_created ON jlap_submissions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_idflag_status_created ON id_flag_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
`);

const row = db
  .prepare("SELECT id FROM site_custom WHERE id = 1")
  .get();
if (!row) {
  db.prepare(
    "INSERT INTO site_custom (id, data_json, updated_at) VALUES (1, '{}', ?)"
  ).run(Date.now());
}

// Apply any pending schema migrations. Each migration is numbered, runs
// inside its own transaction, and records itself in `schema_migrations`
// on success, so restarts are idempotent and a partial ALTER cannot
// leave the DB in a half-migrated state.
runMigrations(db, {
  logger: (msg) => {
    // eslint-disable-next-line no-console
    console.log("[db] " + msg);
  },
});

module.exports = { db, DB_PATH };
