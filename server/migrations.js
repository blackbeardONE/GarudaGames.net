"use strict";

/**
 * Schema migration runner.
 *
 * Each migration is a JS module under server/migrations/ named
 * NNNN_description.js and exporting:
 *     module.exports = {
 *       id:  "NNNN_description",
 *       up:  function (db) { ...synchronous sqlite work... }
 *     };
 *
 * The runner looks up `schema_migrations` (created on demand), runs every
 * migration whose id is not recorded there, and records it once `up()`
 * completes. Each migration runs inside its own `db.transaction()` so a
 * partial ALTER never leaves a half-migrated DB behind.
 *
 * Contract:
 *   - `up(db)` must be idempotent for the "old DB that already has the
 *     target column" case — the runner cannot tell the difference between
 *     a fresh DB and a DB where the baseline CREATE TABLE in db.js already
 *     covers the migration. Use `tableHasColumn()` before any ALTER.
 *   - Do not delete or rename migration files. If a migration turns out
 *     to be wrong, write a new one that corrects it.
 */

const fs = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

function tableHasColumn(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

function ensureSchemaMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
}

function alreadyApplied(db, id) {
  const row = db
    .prepare("SELECT id FROM schema_migrations WHERE id = ?")
    .get(id);
  return Boolean(row);
}

function recordApplied(db, id) {
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)"
  ).run(id, Date.now());
}

function loadMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => {
      const mod = require(path.join(MIGRATIONS_DIR, f));
      if (!mod || typeof mod.up !== "function" || typeof mod.id !== "string") {
        throw new Error(
          `Migration ${f} is malformed (missing { id, up(db) })`
        );
      }
      return mod;
    });
}

/**
 * Run every pending migration. Returns the list of ids that were actually
 * applied on this invocation (useful for tests and boot-log noise).
 */
function runMigrations(db, { logger } = {}) {
  const log = logger || (() => {});
  ensureSchemaMigrationsTable(db);
  const applied = [];
  for (const m of loadMigrations()) {
    if (alreadyApplied(db, m.id)) continue;
    try {
      db.transaction(() => {
        m.up(db, { tableHasColumn });
        recordApplied(db, m.id);
      })();
      log(`migration applied: ${m.id}`);
      applied.push(m.id);
    } catch (err) {
      // Record enough context that boot failures are obvious.
      const wrapped = new Error(
        `migration ${m.id} failed: ${err.message}`
      );
      wrapped.cause = err;
      throw wrapped;
    }
  }
  return applied;
}

module.exports = { runMigrations, tableHasColumn };
