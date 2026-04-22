"use strict";

const express = require("express");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const { promisify } = require("util");
const path = require("path");
const rateLimit = require("express-rate-limit");
const sanitizeHtml = require("sanitize-html");
const qrcode = require("qrcode");
const { db } = require("./db");
const totp = require("./totp");

const scryptAsync = promisify(crypto.scrypt);

const PORT = parseInt(process.env.PORT || "3000", 10);
const NODE_ENV = process.env.NODE_ENV || "production";
// "development" and "test" are both treated as non-prod: cookies allowed
// over HTTP, origin guard permissive about missing Origin/Referer, etc.
const IS_PROD = NODE_ENV !== "development" && NODE_ENV !== "test";

const COOKIE_NAME = "garuda_sid";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days (down from 30).
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const KDF_LABEL = `scrypt-N${SCRYPT_N}-r${SCRYPT_R}-p${SCRYPT_P}`;
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2 + 1024 * 1024;

// Per-field upload caps (base64 data URL length including prefix).
// Numbers are tighter than before to keep total DB growth manageable.
const MAX_PHOTO_URL = 1_500_000;
const MAX_POSTER_URL = 2_500_000;
const MAX_CERT_URL = 2_500_000;
const MAX_QR_URL = 1_000_000;

// Per-user hard caps on number of pending/unverified artifacts.
const MAX_PENDING_ACHIEVEMENTS_PER_USER = 25;
const MAX_PENDING_JLAP_PER_USER = 5;

// Garuda Games scoring rules (server-authoritative).
// Champion / Swiss King / 2nd / 3rd are always 20/10/10/5. Any member of the
// extended podium (4th and below) is worth 2. Grand Tournaments (64 or more
// players) double every awarded value.
const RANK_CODES = Object.freeze({
  champ: { base: 20, label: "Champion" },
  swiss_king: { base: 10, label: "Swiss King" },
  "2nd": { base: 10, label: "2nd" },
  "3rd": { base: 5, label: "3rd" },
  podium: { base: 2, label: "Podium" },
});

// Legacy rank names kept only so pre-migration pending submissions can still
// be verified. New submissions must use `rankCode` + `placement`.
const LEGACY_RANK_POINTS = Object.freeze({
  Champion: 20,
  Finalist: 10,
  "2nd": 10,
  "3rd": 5,
  "4th": 2,
  "Swiss King": 10,
});

function ordinalSuffix(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return n + "th";
  switch (n % 10) {
    case 1: return n + "st";
    case 2: return n + "nd";
    case 3: return n + "rd";
    default: return n + "th";
  }
}

function isGrandTournament(playerCount) {
  return Number(playerCount) >= 64;
}

function computeAchievementPoints(rankCode, placement, playerCount) {
  const meta = RANK_CODES[rankCode];
  if (!meta) return 0;
  let base = meta.base;
  if (rankCode === "podium") {
    const p = parseInt(placement, 10) || 0;
    if (p < 4) return 0;
    base = 2;
  }
  return isGrandTournament(playerCount) ? base * 2 : base;
}

function rankDisplay(rankCode, placement) {
  const meta = RANK_CODES[rankCode];
  if (!meta) return "";
  if (rankCode === "podium") {
    const p = parseInt(placement, 10) || 0;
    return p >= 4 ? ordinalSuffix(p) : meta.label;
  }
  return meta.label;
}

// Allowed game categories. Keep aligned with the <option> lists on signup.html,
// dashboard.html and the client-side ALL_GAMES arrays.
const ALLOWED_GAMES = Object.freeze([
  "Beyblade X",
  "Call of Duty: Mobile",
  "Dota 2",
  "Honor of Kings",
  "Mobile Legends",
  "Tekken",
  "Valorant",
]);

function normalizeGame(value) {
  const s = String(value || "").trim();
  if (!s) return "Beyblade X";
  const hit = ALLOWED_GAMES.find((g) => g.toLowerCase() === s.toLowerCase());
  return hit || "Beyblade X";
}

// Canonicalize an array of game names claimed under the PRO program. Unknown
// entries are dropped silently (we don't want a typo to hold up a whole
// ID-flag review). Order follows ALLOWED_GAMES so responses are stable
// regardless of what the client sent.
function normalizeProGames(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const item of value) {
    const s = String(item || "").trim().toLowerCase();
    if (!s) continue;
    const hit = ALLOWED_GAMES.find((g) => g.toLowerCase() === s);
    if (hit) seen.add(hit);
  }
  return ALLOWED_GAMES.filter((g) => seen.has(g));
}

// Parse the JSON array stored on a user/id_flag_requests row. Defaults to an
// empty array on corruption. Legacy rows where `pro_games_json` is missing
// but `professional_blader = 1` are treated as a single-entry Beyblade X
// list so the old column still works for unmigrated deployments.
function readProGames(row) {
  if (!row) return [];
  let arr = [];
  try {
    const raw = row.pro_games_json;
    if (typeof raw === "string" && raw) {
      arr = JSON.parse(raw);
      if (!Array.isArray(arr)) arr = [];
    }
  } catch (_) {
    arr = [];
  }
  const cleaned = normalizeProGames(arr);
  if (!cleaned.length && row.professional_blader) {
    return ["Beyblade X"];
  }
  return cleaned;
}

// Two lists are equal as sets of canonical game names.
function proGamesEqual(a, b) {
  const na = normalizeProGames(a);
  const nb = normalizeProGames(b);
  if (na.length !== nb.length) return false;
  for (let i = 0; i < na.length; i++) if (na[i] !== nb[i]) return false;
  return true;
}

// Squad-level title. Distinct from the system role (user / verifier / admin)
// which controls access, this names the member's standing inside their
// squad and is admin-managed only. Stored in the `club_role` column.
const ALLOWED_CLUB_ROLES = Object.freeze([
  "Founder",
  "Head Captain",
  "Captain",
  "Vice Captain",
  "Member",
]);

function normalizeClubRole(value, fallback) {
  const s = String(value == null ? "" : value).trim();
  if (!s) return fallback === undefined ? "Member" : fallback;
  const hit = ALLOWED_CLUB_ROLES.find(
    (r) => r.toLowerCase() === s.toLowerCase()
  );
  // Unknown strings collapse to "Member" rather than rejecting the whole
  // request; the admin UI still guides users to a canonical choice.
  return hit || "Member";
}

// Default club tag prefixed to every blader name across the public surface.
// Admins can override via PUT /api/admin/site { clubTag }. Declared up here
// so validation helpers (e.g. IGN checks) can reach it.
const DEFAULT_CLUB_TAG = "GRD|TAS";

// Reads the current club tag from site_custom, falling back to the default.
// The `db` handle is module-local, so this only works once `db` is opened —
// which is the case for every call site (registration, profile patch, admin
// CRUD) since those run after server boot.
function getCurrentClubTag() {
  try {
    const row = db
      .prepare(`SELECT data_json FROM site_custom WHERE id = 1`)
      .get();
    if (row && row.data_json) {
      const data = JSON.parse(row.data_json);
      if (typeof data.clubTag === "string" && data.clubTag.trim()) {
        return data.clubTag.trim();
      }
    }
  } catch (_) {
    /* fall through to default */
  }
  return DEFAULT_CLUB_TAG;
}

// Heuristic: does an achievement event name look like a Judge Like a Pro /
// Certified Judge submission that should live under JLAP instead? Matches
// "JLAP", "Judge Like a Pro" (any spacing/casing), or standalone references
// to "certified judge". Intentionally conservative to avoid bouncing real
// tournaments whose names happen to contain "judge" as a casual word.
function eventLooksLikeJlap(name) {
  const s = String(name || "").toLowerCase();
  if (!s.trim()) return false;
  if (s.includes("jlap")) return true;
  if (/judge\s*like\s*a\s*pro/.test(s)) return true;
  if (/certified\s+judge/.test(s)) return true;
  return false;
}

// Normalize a date string to strict YYYY-MM-DD. Returns '' if missing or
// invalid. Rejects dates before 2000-01-01 (obvious typo / impossible
// Beyblade X era) and any date more than 1 day in the future (allowing the
// tiny slack keeps submissions at midnight UTC from a different timezone
// from bouncing).
function normalizeEventDate(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return "";
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  if (y < 2000 || y > 2100) return "";
  if (mo < 1 || mo > 12) return "";
  if (d < 1 || d > 31) return "";
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    // Rejects e.g. 2026-02-31.
    return "";
  }
  const tomorrow = Date.now() + 36 * 60 * 60 * 1000;
  if (dt.getTime() > tomorrow) return "";
  return s;
}

// Rejects an IGN that embeds the club tag — the tag is applied on display,
// so storing it would double-prefix the name everywhere. Whitespace-tolerant:
// treats "GRD|TAS", "GRD | TAS", "GRD |TAS", "grd\t|\ttas", etc. as matches.
function ignContainsClubTag(ign) {
  const tag = getCurrentClubTag();
  if (!tag) return false;
  const squash = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
  const needle = squash(tag);
  if (!needle) return false;
  return squash(ign).includes(needle);
}

// Parse a ?season= query value. Supported shapes:
//   all         -> no filter
//   YYYY        -> Jan 1 00:00 .. Jan 1 next year 00:00 (UTC)
//   YYYY-MM     -> first day of month .. first day of next month (UTC)
//   YYYY-Sn     -> 4-month ranking season (n = 1..3). Three seasons per
//                  calendar year so each season covers a third of the year:
//                    S1 = Jan 1 .. May 1   (January through April)
//                    S2 = May 1 .. Sep 1   (May through August)
//                    S3 = Sep 1 .. Jan 1   (September through December; wraps year)
// Pads a number to 2 digits for ISO date strings.
function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

// Format a UTC ms timestamp as YYYY-MM-DD (UTC). Used to build the date-string
// bounds that match achievements.event_date (a stored ISO date).
function isoDateUtc(ms) {
  const d = new Date(ms);
  return (
    d.getUTCFullYear() +
    "-" +
    pad2(d.getUTCMonth() + 1) +
    "-" +
    pad2(d.getUTCDate())
  );
}

// Returns the millisecond [start, end) window AND the equivalent ISO date
// bounds [startDate, endDate). Callers that want to bucket by event_date
// should use the date bounds; callers that care about when a row was
// recorded (created_at / verified_at) should use the ms bounds.
function parseSeasonWindow(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v || v === "all") return null;

  function windowFromRange(startMs, endMs) {
    return {
      start: startMs,
      end: endMs,
      startDate: isoDateUtc(startMs),
      endDate: isoDateUtc(endMs),
    };
  }

  let m = /^(\d{4})-s([1-4])$/.exec(v);
  if (m) {
    const y = parseInt(m[1], 10);
    const s = parseInt(m[2], 10);
    // Season n starts at month (n-1)*3 and runs for 3 months.
    //   S1 = Jan–Mar, S2 = Apr–Jun, S3 = Jul–Sep, S4 = Oct–Dec
    const startMonthIdx = (s - 1) * 3; // 0, 3, 6, 9
    const start = Date.UTC(y, startMonthIdx, 1);
    const end =
      s === 4 ? Date.UTC(y + 1, 0, 1) : Date.UTC(y, startMonthIdx + 3, 1);
    return windowFromRange(start, end);
  }
  m = /^(\d{4})-(\d{1,2})$/.exec(v);
  if (m) {
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    if (mo < 1 || mo > 12) return null;
    const start = Date.UTC(y, mo - 1, 1);
    const end = Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1);
    return windowFromRange(start, end);
  }
  m = /^(\d{4})$/.exec(v);
  if (m) {
    const y = parseInt(m[1], 10);
    return windowFromRange(Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1));
  }
  return null;
}

// Which season does a given ms timestamp fall into? Returns a label like
// "2026 Season 1" — used purely for display in portfolio summaries.
function seasonLabelForMs(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  const s = Math.min(4, Math.max(1, Math.floor(mo / 3) + 1));
  return y + " Season " + s;
}

// Date (YYYY-MM-DD) → season label. Mirrors seasonLabelForMs but off the
// stored event_date text field so legacy rows (no event_date) can fall back
// to verified_at/created_at at the caller.
function seasonLabelForIsoDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return "";
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10) - 1;
  const s = Math.min(4, Math.max(1, Math.floor(mo / 3) + 1));
  return y + " Season " + s;
}

// Current live season (four 3-month buckets per year):
//   S1 = Jan–Mar, S2 = Apr–Jun, S3 = Jul–Sep, S4 = Oct–Dec.
// Derived purely from the server clock so points auto-reset when the season
// rolls over — no cron job, no state, no manual "close season" step.
function currentActiveSeason() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth();
  const s = Math.min(4, Math.max(1, Math.floor(mo / 3) + 1));
  const key = y + "-s" + s;
  const w = parseSeasonWindow(key);
  return {
    key,
    label: y + " Season " + s,
    startMs: w.start,
    endMs: w.end,
    startDate: w.startDate,
    endDate: w.endDate,
  };
}

// Live points buckets for a single blader. Always computed straight from the
// achievements table (no denormalized counter to drift):
//
//   * lifetimePoints   — every verified rank_points, all seasons, all games.
//   * activeSeasonPoints — only achievements whose event_date falls inside
//     the current season. Legacy rows (blank event_date) fall back to
//     verified_at/created_at so the roll-out doesn't wipe existing totals.
//
// Because this reads from the same event_date-with-legacy-fallback rule the
// leaderboard uses, the dashboard's "active season" number always matches
// the leaderboard's "this season" column.
function computeUserPointsBuckets(username) {
  const season = currentActiveSeason();
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(rank_points), 0) AS lifetime_points,
         COALESCE(SUM(CASE WHEN (
             (event_date != '' AND event_date >= @startDate AND event_date < @endDate)
             OR (event_date = ''
                 AND COALESCE(verified_at, created_at) >= @startMs
                 AND COALESCE(verified_at, created_at) < @endMs)
           ) THEN rank_points ELSE 0 END), 0) AS active_points,
         COALESCE(SUM(CASE WHEN (
             (event_date != '' AND event_date >= @startDate AND event_date < @endDate)
             OR (event_date = ''
                 AND COALESCE(verified_at, created_at) >= @startMs
                 AND COALESCE(verified_at, created_at) < @endMs)
           ) THEN 1 ELSE 0 END), 0) AS active_events,
         COALESCE(COUNT(*), 0) AS lifetime_events
       FROM achievements
       WHERE username = @u AND status = 'verified'`
    )
    .get({
      u: username,
      startDate: season.startDate,
      endDate: season.endDate,
      startMs: season.startMs,
      endMs: season.endMs,
    });
  return {
    lifetimePoints: (row && row.lifetime_points) || 0,
    lifetimeEvents: (row && row.lifetime_events) || 0,
    activeSeasonPoints: (row && row.active_points) || 0,
    activeSeasonEvents: (row && row.active_events) || 0,
    activeSeason: {
      key: season.key,
      label: season.label,
      startDate: season.startDate,
      endDate: season.endDate,
    },
  };
}

// Origins allowed to hit the API with state-changing verbs.
// In production the browser origin is HTTPS garudagames.net; in development any localhost is fine.
const ALLOWED_ORIGINS = (process.env.GARUDA_ALLOWED_ORIGINS ||
  "https://garudagames.net,https://www.garudagames.net")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// A tiny blocklist of obviously bad passwords. This is intentionally short; it
// complements the structural policy, it does not replace it.
const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "passw0rd", "p@ssword",
  "qwerty123", "qwertyuiop", "123456789", "1234567890", "abcdefg",
  "letmein123", "welcome123", "iloveyou", "admin1234", "administrator",
  "changeme", "changeme123", "garuda", "garudagames", "beyblade",
]);

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

// Pull client IP from the trust-proxy chain rather than socket.
app.use((req, _res, next) => {
  req.clientIp = req.ip || req.socket.remoteAddress || "";
  next();
});

app.use(express.json({ limit: "4mb" }));
app.use(cookieParser());

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function ok(res, data) {
  res.json({ ok: true, ...data });
}
function fail(res, status, message) {
  res.status(status).json({ ok: false, error: message });
}

function normUser(u) {
  return String(u || "").trim().toLowerCase();
}

function uid(prefix) {
  return (
    (prefix || "g_") +
    Date.now().toString(36) +
    "_" +
    crypto.randomBytes(6).toString("hex")
  );
}

async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(String(plain), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return { hash, salt, kdf: KDF_LABEL };
}

async function verifyPassword(plain, salt, expected, kdf) {
  const m = /scrypt-N(\d+)-r(\d+)-p(\d+)/.exec(kdf || "");
  const N = m ? parseInt(m[1], 10) : SCRYPT_N;
  const r = m ? parseInt(m[2], 10) : SCRYPT_R;
  const p = m ? parseInt(m[3], 10) : SCRYPT_P;
  const maxmem = 128 * N * r * 2 + 1024 * 1024;
  const derived = await scryptAsync(String(plain), salt, expected.length, {
    N,
    r,
    p,
    maxmem,
  });
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function passwordPolicyError(password, username) {
  const p = String(password || "");
  if (p.length < 12) {
    return "Password must be at least 12 characters.";
  }
  if (p.length > 256) {
    return "Password is too long (max 256 characters).";
  }
  const lower = /[a-z]/.test(p);
  const upper = /[A-Z]/.test(p);
  const digit = /[0-9]/.test(p);
  const symbol = /[^A-Za-z0-9]/.test(p);
  const classes = [lower, upper, digit, symbol].filter(Boolean).length;
  if (p.length < 16 && classes < 3) {
    return "Use at least three of: lowercase, uppercase, digit, symbol — or a passphrase of 16+ characters.";
  }
  if (COMMON_PASSWORDS.has(p.toLowerCase())) {
    return "That password is on the common-passwords blocklist.";
  }
  if (username && p.toLowerCase().includes(String(username).toLowerCase())) {
    return "Password must not contain your username.";
  }
  return null;
}

function profileFromRow(row) {
  if (!row) return null;
  let games = [];
  try {
    games = JSON.parse(row.games_json || "[]");
    if (!Array.isArray(games)) games = [];
  } catch (_) {
    games = [];
  }
  const proGames = readProGames(row);
  return {
    username: row.username,
    role: row.role,
    ign: row.ign,
    realName: row.real_name,
    squad: row.squad,
    clubRole: row.club_role,
    games,
    photoDataUrl: row.photo_data_url || "",
    certifiedJudge: !!row.certified_judge,
    professionalBlader: proGames.includes("Beyblade X"),
    proGames,
    points: row.points || 0,
    createdAt: row.created_at,
    totpEnabled: !!row.totp_enabled,
  };
}

// Minimal roster entry for the authenticated directory. No photo, no real name.
function rosterEntry(row) {
  if (!row) return null;
  let games = [];
  try {
    games = JSON.parse(row.games_json || "[]");
    if (!Array.isArray(games)) games = [];
  } catch (_) {
    games = [];
  }
  const proGames = readProGames(row);
  return {
    username: row.username,
    ign: row.ign,
    squad: row.squad,
    clubRole: row.club_role,
    games,
    certifiedJudge: !!row.certified_judge,
    professionalBlader: proGames.includes("Beyblade X"),
    proGames,
  };
}

// Response for the public "is this person really on the roster?" verify page.
// Includes photo + real name by design — matches the flow on members.html.
// Also returns the username handle so the verify page can deep-link to the
// blader's public portfolio (portfolio.html?u=<username>).
function verifyMatch(row) {
  if (!row) return null;
  let games = [];
  try {
    games = JSON.parse(row.games_json || "[]");
    if (!Array.isArray(games)) games = [];
  } catch (_) {
    games = [];
  }
  const proGames = readProGames(row);
  return {
    username: row.username,
    ign: row.ign,
    realName: row.real_name,
    squad: row.squad,
    clubRole: row.club_role,
    games,
    photoDataUrl: row.photo_data_url || "",
    certifiedJudge: !!row.certified_judge,
    professionalBlader: proGames.includes("Beyblade X"),
    proGames,
  };
}

function auditLog(actor, action, target, detail, ip) {
  try {
    db.prepare(
      `INSERT INTO audit_log (actor, action, target, detail_json, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      String(actor || "system"),
      String(action),
      target ? String(target) : null,
      JSON.stringify(detail || {}),
      ip ? String(ip).slice(0, 64) : null,
      Date.now()
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("auditLog failed:", e.message);
  }
}

function notify(username, kind, title, body, link) {
  try {
    db.prepare(
      `INSERT INTO notifications (id, username, kind, title, body, link, created_at)
       VALUES (@id, @username, @kind, @title, @body, @link, @created_at)`
    ).run({
      id: uid("ntf_"),
      username: String(username).toLowerCase(),
      kind: String(kind || "info").slice(0, 32),
      title: String(title || "").slice(0, 160),
      body: String(body || "").slice(0, 512),
      link: String(link || "").slice(0, 256),
      created_at: Date.now(),
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("notify failed:", e.message);
  }
}

// --------------------------------------------------------------------------
// Sessions
// --------------------------------------------------------------------------

function clearCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

function setSessionCookie(res, sid) {
  res.cookie(COOKIE_NAME, sid, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
}

function createSession(username) {
  const sid = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, username, created_at, expires_at) VALUES (?, ?, ?, ?)`
  ).run(sid, username, now, now + SESSION_TTL_MS);
  return sid;
}

function getSession(sid) {
  if (!sid) return null;
  const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sid);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid);
    return null;
  }
  return row;
}

function destroySession(sid) {
  if (!sid) return;
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid);
}

function destroyAllSessionsFor(username) {
  db.prepare(`DELETE FROM sessions WHERE username = ?`).run(normUser(username));
}

function getUserByUsername(username) {
  return db
    .prepare(`SELECT * FROM users WHERE username = ?`)
    .get(normUser(username));
}

function requireAuth(req, res, next) {
  const sid = req.cookies[COOKIE_NAME];
  const s = getSession(sid);
  if (!s) {
    clearCookie(res);
    return fail(res, 401, "Not signed in.");
  }
  const user = getUserByUsername(s.username);
  if (!user) {
    destroySession(sid);
    clearCookie(res);
    return fail(res, 401, "Account no longer exists.");
  }
  req.session = s;
  req.user = user;
  next();
}

function requireRole(minRole) {
  const order = { user: 0, verifier: 1, admin: 2 };
  return (req, res, next) => {
    requireAuth(req, res, (err) => {
      if (err) return next(err);
      if ((order[req.user.role] || 0) < (order[minRole] || 0)) {
        return fail(res, 403, "Forbidden.");
      }
      next();
    });
  };
}

// --------------------------------------------------------------------------
// CSRF / origin protection
// --------------------------------------------------------------------------

// For any state-changing request we require either:
//   - an Origin header matching one of ALLOWED_ORIGINS (in production), OR
//   - in development, a Referer that matches
// Combined with SameSite=Strict session cookies this closes the classic CSRF
// surface without a separate token the frontend has to thread through.
function originGuard(req, res, next) {
  const m = req.method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();

  const origin = req.get("origin");
  const referer = req.get("referer");

  if (!IS_PROD) {
    // Dev: allow same-host referers, allow missing origin (curl/tests).
    if (!origin && !referer) return next();
  }

  const candidate = origin || (referer ? tryParseOrigin(referer) : null);
  if (candidate && ALLOWED_ORIGINS.includes(candidate)) return next();

  return fail(res, 403, "Cross-origin request rejected.");
}

function tryParseOrigin(url) {
  try {
    const u = new URL(url);
    return u.origin;
  } catch (_) {
    return null;
  }
}

app.use(originGuard);

// --------------------------------------------------------------------------
// Rate limiting (defense in depth; nginx has its own zone too)
// --------------------------------------------------------------------------

// In the test env (NODE_ENV=test) we skip the rate limiter outright so the
// suite can replay hundreds of auth+api requests from the same 127.0.0.1
// without tripping the 15-per-10-min auth cap. The nginx zone is the real
// defence in production anyway; the in-process limiter is redundant.
const SKIP_RATE_LIMIT = NODE_ENV === "test";
const passthrough = (_req, _res, next) => next();

const authLimiter = SKIP_RATE_LIMIT
  ? passthrough
  : rateLimit({
      windowMs: 10 * 60 * 1000,
      limit: 15,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: {
        ok: false,
        error: "Too many auth attempts. Try again shortly.",
      },
    });

const apiLimiter = SKIP_RATE_LIMIT
  ? passthrough
  : rateLimit({
      windowMs: 60 * 1000,
      limit: 120,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: { ok: false, error: "Too many requests. Slow down." },
    });

const lookupLimiter = SKIP_RATE_LIMIT
  ? passthrough
  : rateLimit({
      windowMs: 60 * 1000,
      limit: 20,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: {
        ok: false,
        error: "Too many lookups. Try again shortly.",
      },
    });

// Apply the general API limiter to everything; specific routes opt into stricter ones below.
app.use("/api/", apiLimiter);

// Progressive per-username lockout on top of IP-based limits. Counts the last
// 10 minutes of failures for a username; anything over 10 locks further tries.
function recordLoginAttempt(key, success) {
  db.prepare(
    `INSERT INTO login_attempts (key, success, created_at) VALUES (?, ?, ?)`
  ).run(String(key), success ? 1 : 0, Date.now());
  // Opportunistic cleanup of rows older than an hour.
  db.prepare(`DELETE FROM login_attempts WHERE created_at < ?`).run(
    Date.now() - 60 * 60 * 1000
  );
}

function recentFailures(key, windowMs) {
  const since = Date.now() - windowMs;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM login_attempts
         WHERE key = ? AND success = 0 AND created_at >= ?`
    )
    .get(String(key), since);
  return row ? row.c : 0;
}

// --------------------------------------------------------------------------
// Public, unauthenticated routes
// --------------------------------------------------------------------------

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "garuda-api", time: Date.now() });
});

// Auth endpoints get the strictest rate limiter.
app.post("/api/auth/register", authLimiter, async (req, res) => {
  const body = req.body || {};
  const username = normUser(body.username);
  const password = String(body.password || "");
  const ign = String(body.ign || "").trim();
  const realName = String(body.realName || "").trim();
  const squad = String(body.squad || "").trim();
  const clubRole = String(body.clubRole || "").trim();
  let games = body.games;
  if (!Array.isArray(games)) games = [];
  games = games.map((g) => String(g || "").trim()).filter(Boolean);
  if (!games.length) games = ["Beyblade X"];

  if (!/^[a-z0-9_]{3,32}$/.test(username)) {
    return fail(
      res,
      400,
      "Username must be 3-32 chars: lowercase letters, digits, underscore."
    );
  }
  const policyErr = passwordPolicyError(password, username);
  if (policyErr) return fail(res, 400, policyErr);

  if (!ign) return fail(res, 400, "IGN is required.");
  if (ign.length > 64) return fail(res, 400, "IGN is too long.");
  if (ignContainsClubTag(ign)) {
    return fail(
      res,
      400,
      `Blader name must not contain the club tag "${getCurrentClubTag()}" — it is added automatically.`
    );
  }
  if (realName.length > 128) return fail(res, 400, "Full name is too long.");

  if (getUserByUsername(username)) {
    return fail(res, 409, "That username is already taken.");
  }

  // New accounts are always 'user'. The first-signup-becomes-admin shortcut is
  // intentionally removed — admins must be seeded through the install flow or
  // promoted by an existing admin.
  const role = "user";
  const now = Date.now();

  const { hash, salt, kdf } = await hashPassword(password);
  db.prepare(
    `INSERT INTO users (
      username, password_hash, password_salt, password_kdf,
      role, ign, real_name, squad, club_role, games_json,
      photo_data_url, certified_judge, professional_blader, points, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, 0, 0, ?)`
  ).run(
    username,
    hash,
    salt,
    kdf,
    role,
    ign,
    realName || ign,
    squad || "Garuda Games",
    clubRole || "Member",
    JSON.stringify(games),
    now
  );

  auditLog("system", "user.register", username, {}, req.clientIp);

  ok(res, { username, role, isFirst: false });
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const body = req.body || {};
  const username = normUser(body.username);
  const password = String(body.password || "");
  const totpCode = String(body.totpCode || "").trim();
  const lockKey = `user:${username}`;

  // Per-user lockout independent of the IP limiter.
  if (recentFailures(lockKey, 10 * 60 * 1000) >= 10) {
    return fail(
      res,
      429,
      "Too many failed attempts for that account. Try again in a few minutes."
    );
  }

  const user = getUserByUsername(username);
  if (!user) {
    recordLoginAttempt(lockKey, false);
    return fail(res, 401, "Invalid username or password.");
  }

  let good = false;
  try {
    good = await verifyPassword(
      password,
      user.password_salt,
      user.password_hash,
      user.password_kdf
    );
  } catch (_) {
    good = false;
  }

  if (!good) {
    recordLoginAttempt(lockKey, false);
    auditLog(username, "auth.login.fail", null, {}, req.clientIp);
    return fail(res, 401, "Invalid username or password.");
  }

  // 2FA gate. When TOTP is enabled on the account, the password being
  // correct is only step one — we DON'T record it as a successful login
  // and we DON'T issue a cookie until the code also verifies.
  //   * First request without totpCode: respond 401 with totpRequired:true
  //     so the client knows to prompt for the code (no session leaks).
  //   * Follow-up with a wrong code: generic "Invalid credentials", same
  //     as a wrong password — no oracle that the password was right.
  //   * Correct code: proceed as normal.
  if (user.totp_enabled) {
    if (!totpCode) {
      return res.status(401).json({
        ok: false,
        error: "Enter your authenticator code to finish signing in.",
        totpRequired: true,
      });
    }
    const good2fa = user.totp_secret && totp.verify(user.totp_secret, totpCode);
    if (!good2fa) {
      recordLoginAttempt(lockKey, false);
      auditLog(username, "auth.login.totp_fail", null, {}, req.clientIp);
      return fail(res, 401, "Invalid username or password.");
    }
  }

  recordLoginAttempt(lockKey, true);
  const sid = createSession(user.username);
  setSessionCookie(res, sid);
  auditLog(user.username, "auth.login.ok", null, {}, req.clientIp);
  ok(res, { user: profileFromRow(user) });
});

app.post("/api/auth/logout", (req, res) => {
  const sid = req.cookies[COOKIE_NAME];
  destroySession(sid);
  clearCookie(res);
  ok(res, {});
});

app.get("/api/auth/me", (req, res) => {
  const sid = req.cookies[COOKIE_NAME];
  const s = getSession(sid);
  if (!s) return ok(res, { user: null });
  const user = getUserByUsername(s.username);
  if (!user) {
    destroySession(sid);
    clearCookie(res);
    return ok(res, { user: null });
  }
  const profile = profileFromRow(user);
  // Replace the legacy denormalized `points` with live totals so the
  // dashboard banner reflects the single source of truth (sum over the
  // achievements table). Keep the `points` key set to the lifetime total
  // so older clients that still read it don't regress.
  const buckets = computeUserPointsBuckets(user.username);
  profile.lifetimePoints = buckets.lifetimePoints;
  profile.lifetimeEvents = buckets.lifetimeEvents;
  profile.activeSeasonPoints = buckets.activeSeasonPoints;
  profile.activeSeasonEvents = buckets.activeSeasonEvents;
  profile.activeSeason = buckets.activeSeason;
  profile.points = buckets.lifetimePoints;
  ok(res, { user: profile });
});

// --------------------------------------------------------------------------
// TOTP / 2FA
// --------------------------------------------------------------------------
//
// Every authenticated user can opt into RFC-6238 TOTP (Google Authenticator,
// 1Password, Authy, Bitwarden, etc.). The setup flow is two-step so a
// half-done setup can't lock anyone out:
//
//   1. POST /api/me/2fa/setup
//        Writes a fresh secret to the user row with totp_enabled=0 and
//        returns it + a data-URL QR code. At this point 2FA is NOT in
//        effect; the user can still log in with password alone.
//   2. POST /api/me/2fa/verify  { code: "123456" }
//        If the code matches the stored secret, flip totp_enabled=1. Any
//        subsequent login will require the code.
//
// Disable path: POST /api/me/2fa/disable { code } — requires a current
// valid code so a hijacked session can't trivially turn it back off.
//
// We do NOT offer scratch codes yet; losing your device means an admin has
// to disable 2FA on your row via the admin panel. Written up in SECURITY.md.

app.get("/api/me/2fa/status", requireAuth, (req, res) => {
  const row = db
    .prepare("SELECT totp_enabled FROM users WHERE username = ?")
    .get(req.user.username);
  ok(res, { enabled: !!(row && row.totp_enabled) });
});

app.post("/api/me/2fa/setup", requireAuth, async (req, res) => {
  const row = db
    .prepare(
      "SELECT totp_enabled FROM users WHERE username = ?"
    )
    .get(req.user.username);
  if (row && row.totp_enabled) {
    return fail(
      res,
      400,
      "Two-factor is already enabled. Disable it first to start over."
    );
  }
  const secret = totp.generateSecret();
  db.prepare(
    "UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE username = ?"
  ).run(secret, req.user.username);

  const otpauth = totp.otpauthUrl({
    issuer: "Garuda Games",
    account: req.user.username,
    secret,
  });
  let qrDataUrl = "";
  try {
    qrDataUrl = await qrcode.toDataURL(otpauth, { margin: 1, width: 240 });
  } catch (e) {
    // QR is nice-to-have; the secret + otpauth URL is enough to set up.
    // eslint-disable-next-line no-console
    console.warn("QR generation failed", e);
  }
  auditLog(req.user.username, "2fa.setup.start", null, {}, req.clientIp);
  ok(res, { secret, otpauthUrl: otpauth, qrDataUrl });
});

app.post("/api/me/2fa/verify", requireAuth, (req, res) => {
  const code = String((req.body && req.body.code) || "").trim();
  const row = db
    .prepare(
      "SELECT totp_secret, totp_enabled FROM users WHERE username = ?"
    )
    .get(req.user.username);
  if (!row || !row.totp_secret) {
    return fail(res, 400, "Start a new setup first (no pending secret).");
  }
  if (!totp.verify(row.totp_secret, code)) {
    auditLog(req.user.username, "2fa.verify.fail", null, {}, req.clientIp);
    return fail(res, 400, "That code didn't match. Try again.");
  }
  db.prepare(
    "UPDATE users SET totp_enabled = 1 WHERE username = ?"
  ).run(req.user.username);
  auditLog(req.user.username, "2fa.enabled", null, {}, req.clientIp);
  ok(res, { enabled: true });
});

app.post("/api/me/2fa/disable", requireAuth, (req, res) => {
  const code = String((req.body && req.body.code) || "").trim();
  const row = db
    .prepare(
      "SELECT totp_secret, totp_enabled FROM users WHERE username = ?"
    )
    .get(req.user.username);
  if (!row || !row.totp_enabled) {
    return fail(res, 400, "Two-factor isn't enabled on this account.");
  }
  if (!totp.verify(row.totp_secret, code)) {
    auditLog(req.user.username, "2fa.disable.fail", null, {}, req.clientIp);
    return fail(res, 400, "That code didn't match. Try again.");
  }
  db.prepare(
    "UPDATE users SET totp_secret = '', totp_enabled = 0 WHERE username = ?"
  ).run(req.user.username);
  auditLog(req.user.username, "2fa.disabled", null, {}, req.clientIp);
  ok(res, { enabled: false });
});

// Admin escape hatch for a member who lost their authenticator device.
// Requires admin role; heavily audited. Does NOT require the code.
app.post(
  "/api/admin/members/:username/2fa/disable",
  requireRole("admin"),
  (req, res) => {
    const target = normUser(req.params.username);
    const row = db
      .prepare("SELECT totp_enabled FROM users WHERE username = ?")
      .get(target);
    if (!row) return fail(res, 404, "Not found.");
    db.prepare(
      "UPDATE users SET totp_secret = '', totp_enabled = 0 WHERE username = ?"
    ).run(target);
    auditLog(
      req.user.username,
      "admin.2fa.disabled",
      target,
      { previouslyEnabled: !!row.totp_enabled },
      req.clientIp
    );
    ok(res, { enabled: false, username: target });
  }
);

// --------------------------------------------------------------------------
// Password reset — admin-issued, one-shot tokens
// --------------------------------------------------------------------------
//
// Flow:
//   1. A member says "I forgot my password" on Discord / in person.
//   2. An admin hits POST /api/admin/members/:u/reset-token to mint a
//      single-use token (256 bits of randomness, 24h TTL). Any previously
//      unused token for the same user is invalidated at the same time.
//   3. The admin forwards the token to the member out-of-band.
//   4. The member pastes token + new password into forgot-password.html,
//      which calls POST /api/auth/reset-password.
//   5. Server verifies the token, hashes the new password, marks the
//      token used, and destroys every active session for that user so a
//      hijacked session can't survive the rotation.
//
// No email server. If email is ever wired up, a self-service "send me a
// reset link" endpoint can be grafted on top of the same token table.

const RESET_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function generateResetToken() {
  return crypto.randomBytes(32).toString("base64url");
}

app.post(
  "/api/admin/members/:username/reset-token",
  requireRole("admin"),
  (req, res) => {
    const target = normUser(req.params.username);
    const existing = getUserByUsername(target);
    if (!existing) return fail(res, 404, "Not found.");

    const now = Date.now();
    const token = generateResetToken();
    const expiresAt = now + RESET_TOKEN_TTL_MS;
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE password_reset_tokens
            SET used_at = ?
          WHERE username = ? AND used_at IS NULL`
      ).run(now, target);
      db.prepare(
        `INSERT INTO password_reset_tokens
            (token, username, issued_by, issued_at, expires_at)
          VALUES (?, ?, ?, ?, ?)`
      ).run(token, target, req.user.username, now, expiresAt);
    });
    tx();
    auditLog(
      req.user.username,
      "admin.password_reset.issue",
      target,
      { expiresAt },
      req.clientIp
    );
    ok(res, { token, expiresAt, expiresInMs: RESET_TOKEN_TTL_MS });
  }
);

app.post("/api/auth/reset-password", authLimiter, async (req, res) => {
  const body = req.body || {};
  const token = String(body.token || "").trim();
  const newPassword = String(body.newPassword || "");
  if (!token) return fail(res, 400, "Missing reset token.");

  const row = db
    .prepare(
      `SELECT token, username, expires_at, used_at
         FROM password_reset_tokens
        WHERE token = ?`
    )
    .get(token);
  // Identical "invalid or expired" error regardless of which check failed;
  // a valid token being expired shouldn't leak through as a different 400
  // than a completely bogus token.
  const now = Date.now();
  if (!row || row.used_at || row.expires_at < now) {
    return fail(res, 400, "That reset link is invalid or has expired.");
  }

  const policyErr = passwordPolicyError(newPassword, row.username);
  if (policyErr) return fail(res, 400, policyErr);

  const { hash, salt, kdf } = await hashPassword(newPassword);
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE users
          SET password_hash = ?, password_salt = ?, password_kdf = ?
        WHERE username = ?`
    ).run(hash, salt, kdf, row.username);
    db.prepare(
      `UPDATE password_reset_tokens SET used_at = ? WHERE token = ?`
    ).run(now, token);
    db.prepare(`DELETE FROM sessions WHERE username = ?`).run(row.username);
  });
  tx();
  auditLog(
    row.username,
    "auth.password_reset.complete",
    null,
    { via: "token" },
    req.clientIp
  );
  ok(res, { username: row.username });
});

// Unauthenticated "verify this person is a member" endpoint.
// Returns a single exact-match entry (IGN *or* real name, case-insensitive).
// No LIKE / fuzzy enumeration, heavily rate-limited.
app.post("/api/members/lookup", lookupLimiter, (req, res) => {
  const q = String((req.body && req.body.query) || "").trim();
  if (!q) return ok(res, { match: null });
  if (q.length > 64) return ok(res, { match: null });
  const exact = q.toLowerCase();
  const row = db
    .prepare(
      `SELECT * FROM users
        WHERE LOWER(ign) = ? OR LOWER(real_name) = ?
        ORDER BY ign COLLATE NOCASE
        LIMIT 1`
    )
    .get(exact, exact);
  ok(res, { match: row ? verifyMatch(row) : null });
});

// Public blader portfolio. Returns the member's profile summary and every
// *verified* achievement they've earned. The handle can be either the
// canonical username or the IGN (case-insensitive) so deep-links from
// members.html, leaderboard.html, and hand-shared URLs all resolve.
//
// Response intentionally excludes posters/real name/squad-email so the
// endpoint can stay fully public (no auth required). The member's career
// record is treated as opt-in public by virtue of being displayed on the
// leaderboard already.
app.get("/api/portfolio/:handle", lookupLimiter, (req, res) => {
  const handle = String(req.params.handle || "").trim();
  if (!handle || handle.length > 64) return fail(res, 404, "Not found.");
  const needle = handle.toLowerCase();
  const userRow = db
    .prepare(
      `SELECT username, ign, squad, club_role, games_json, photo_data_url,
              certified_judge, professional_blader, pro_games_json,
              points, created_at
         FROM users
        WHERE LOWER(username) = ? OR LOWER(ign) = ?
        ORDER BY ign COLLATE NOCASE
        LIMIT 1`
    )
    .get(needle, needle);
  if (!userRow) return fail(res, 404, "Not found.");

  const ach = db
    .prepare(
      `SELECT id, event_name, event_date, game, rank, rank_code, placement,
              player_count, rank_points, challonge_url, verified_at, created_at
         FROM achievements
        WHERE username = ? AND status = 'verified'
        ORDER BY
          CASE WHEN event_date = '' THEN 1 ELSE 0 END,
          event_date DESC,
          verified_at DESC,
          created_at DESC`
    )
    .all(userRow.username);

  const items = ach.map((r) => {
    const playerCount = r.player_count || 0;
    const seasonLabel = r.event_date
      ? seasonLabelForIsoDate(r.event_date)
      : r.verified_at
      ? seasonLabelForMs(r.verified_at)
      : r.created_at
      ? seasonLabelForMs(r.created_at)
      : "";
    return {
      id: r.id,
      eventName: r.event_name,
      eventDate: r.event_date || "",
      game: r.game || "Beyblade X",
      rank: r.rank,
      rankCode: r.rank_code || "",
      placement: r.placement || 0,
      playerCount,
      isGrandTournament: isGrandTournament(playerCount),
      rankPoints: r.rank_points,
      challongeUrl: r.challonge_url,
      verifiedAt: r.verified_at,
      createdAt: r.created_at,
      season: seasonLabel,
    };
  });

  let games = [];
  try {
    games = JSON.parse(userRow.games_json || "[]");
    if (!Array.isArray(games)) games = [];
  } catch (_) {
    games = [];
  }

  const season = currentActiveSeason();
  const perGame = {};
  let lifetimePoints = 0;
  let activeSeasonPoints = 0;
  let activeSeasonEvents = 0;
  let champs = 0;
  let podiums = 0;

  // Matches the leaderboard & /auth/me rule: event_date drives season,
  // legacy rows (no date) fall back to verified_at/created_at.
  function inActiveSeason(it) {
    if (it.eventDate) {
      return it.eventDate >= season.startDate && it.eventDate < season.endDate;
    }
    const ts = it.verifiedAt || it.createdAt || 0;
    return ts >= season.startMs && ts < season.endMs;
  }

  items.forEach((it) => {
    lifetimePoints += it.rankPoints || 0;
    if (inActiveSeason(it)) {
      activeSeasonPoints += it.rankPoints || 0;
      activeSeasonEvents += 1;
    }
    if (it.rankCode === "champ") champs += 1;
    if (it.rankCode === "2nd" || it.rankCode === "3rd" || it.rankCode === "podium") {
      podiums += 1;
    }
    const g = it.game || "Beyblade X";
    if (!perGame[g]) perGame[g] = { game: g, points: 0, events: 0 };
    perGame[g].points += it.rankPoints || 0;
    perGame[g].events += 1;
  });

  const userProGames = readProGames(userRow);
  ok(res, {
    profile: {
      username: userRow.username,
      ign: userRow.ign,
      squad: userRow.squad || "",
      clubRole: userRow.club_role || "Member",
      photoDataUrl: userRow.photo_data_url || "",
      games,
      certifiedJudge: !!userRow.certified_judge,
      professionalBlader: userProGames.includes("Beyblade X"),
      proGames: userProGames,
      memberSince: userRow.created_at || null,
    },
    stats: {
      lifetimePoints,
      totalEvents: items.length,
      championships: champs,
      podiums,
      activeSeasonPoints,
      activeSeasonEvents,
      activeSeason: {
        key: season.key,
        label: season.label,
        startDate: season.startDate,
        endDate: season.endDate,
      },
      perGame: Object.keys(perGame)
        .sort()
        .map((g) => perGame[g]),
    },
    achievements: items,
  });
});

// --------------------------------------------------------------------------
// Authenticated routes (signed-in members only)
// --------------------------------------------------------------------------

// Roster for logged-in members only. No photos, no real names.
app.get("/api/members", requireAuth, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT username, role, ign, real_name, squad, club_role, games_json,
              certified_judge, professional_blader, pro_games_json
         FROM users
        ORDER BY ign COLLATE NOCASE`
    )
    .all();
  ok(res, { members: rows.map(rosterEntry) });
});

// Member count is now only disclosed to authenticated users.
app.get("/api/auth/stats", requireAuth, (_req, res) => {
  const row = db.prepare("SELECT COUNT(*) AS c FROM users").get();
  ok(res, { memberCount: row ? row.c : 0 });
});

app.patch("/api/me/profile", requireAuth, (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (typeof body.photoDataUrl === "string") {
    patch.photo_data_url = body.photoDataUrl.slice(0, MAX_PHOTO_URL);
  }
  if (typeof body.ign === "string" && body.ign.trim()) {
    const newIgn = body.ign.trim().slice(0, 64);
    if (ignContainsClubTag(newIgn)) {
      return fail(
        res,
        400,
        `Blader name must not contain the club tag "${getCurrentClubTag()}" — it is added automatically.`
      );
    }
    patch.ign = newIgn;
  }
  if (typeof body.realName === "string") {
    patch.real_name = body.realName.trim().slice(0, 128);
  }
  if (typeof body.squad === "string") {
    patch.squad = body.squad.trim().slice(0, 64);
  }
  // Club role is admin-managed only — members cannot self-promote to
  // Captain / Vice Captain. Any `clubRole` key in the member-facing
  // profile patch is ignored here on purpose.
  if (Array.isArray(body.games)) {
    const games = body.games.map((g) => String(g || "").trim()).filter(Boolean);
    patch.games_json = JSON.stringify(games.length ? games : ["Beyblade X"]);
  }
  const keys = Object.keys(patch);
  if (!keys.length) return ok(res, { user: profileFromRow(req.user) });
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE users SET ${sets} WHERE username = @username`).run({
    ...patch,
    username: req.user.username,
  });
  const updated = getUserByUsername(req.user.username);
  ok(res, { user: profileFromRow(updated) });
});

app.patch("/api/me/password", requireAuth, async (req, res) => {
  const body = req.body || {};
  const current = String(body.currentPassword || "");
  const next = String(body.newPassword || "");
  const policyErr = passwordPolicyError(next, req.user.username);
  if (policyErr) return fail(res, 400, policyErr);
  if (current === next) {
    return fail(res, 400, "New password must differ from the current one.");
  }
  let good = false;
  try {
    good = await verifyPassword(
      current,
      req.user.password_salt,
      req.user.password_hash,
      req.user.password_kdf
    );
  } catch (_) {
    good = false;
  }
  if (!good) {
    auditLog(
      req.user.username,
      "password.change.fail",
      null,
      { reason: "bad_current" },
      req.clientIp
    );
    return fail(res, 401, "Current password is incorrect.");
  }
  const h = await hashPassword(next);
  db.prepare(
    `UPDATE users SET password_hash = ?, password_salt = ?, password_kdf = ?
      WHERE username = ?`
  ).run(h.hash, h.salt, h.kdf, req.user.username);
  // Revoke every other session for this account; keep the current one.
  db.prepare(
    `DELETE FROM sessions WHERE username = ? AND id != ?`
  ).run(req.user.username, req.session ? req.session.id : "");
  auditLog(
    req.user.username,
    "password.change",
    null,
    {},
    req.clientIp
  );
  ok(res, {});
});

app.get("/api/me/notifications", requireAuth, (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
  const rows = db
    .prepare(
      `SELECT id, kind, title, body, link, read_at, created_at
         FROM notifications
        WHERE username = ?
        ORDER BY created_at DESC
        LIMIT ?`
    )
    .all(req.user.username, limit);
  const unread = db
    .prepare(
      `SELECT COUNT(*) AS c FROM notifications
        WHERE username = ? AND read_at IS NULL`
    )
    .get(req.user.username);
  ok(res, {
    notifications: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      link: r.link,
      readAt: r.read_at,
      createdAt: r.created_at,
    })),
    unreadCount: unread ? unread.c : 0,
  });
});

app.post("/api/me/notifications/read", requireAuth, (req, res) => {
  const body = req.body || {};
  const now = Date.now();
  if (body.all === true) {
    db.prepare(
      `UPDATE notifications SET read_at = ?
        WHERE username = ? AND read_at IS NULL`
    ).run(now, req.user.username);
    return ok(res, {});
  }
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((s) => typeof s === "string").slice(0, 100)
    : [];
  if (!ids.length) return fail(res, 400, "Provide ids[] or all:true.");
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE notifications SET read_at = ?
      WHERE username = ? AND read_at IS NULL AND id IN (${placeholders})`
  ).run(now, req.user.username, ...ids);
  ok(res, {});
});

// Public read-only leaderboard built from verified achievements (so it's
// always the authoritative point total — points stored on the user row can
// drift if rank_points are later retuned).
app.get("/api/leaderboard", (req, res) => {
  const rawGame = String((req.query && req.query.game) || "").trim();
  const gameFilter =
    rawGame && rawGame.toLowerCase() !== "all"
      ? ALLOWED_GAMES.find((g) => g.toLowerCase() === rawGame.toLowerCase()) || null
      : null;
  const window = parseSeasonWindow(req.query && req.query.season);

  const whereAchieve = ["a.status = 'verified'"];
  const whereParams = {};
  if (gameFilter) {
    whereAchieve.push("a.game = @game");
    whereParams.game = gameFilter;
  }
  if (window) {
    // Season windowing lives on the date the event actually happened, not
    // the day we happened to verify it. That way:
    //   * Old tournaments (Dec 2025) submitted now land in their real
    //     season (S3 2025), so they don't inflate the current season.
    //   * Legacy rows (event_date = '') — submitted before the required-
    //     date feature shipped — fall back to verified_at/created_at so
    //     existing leaderboard data doesn't disappear overnight. Once the
    //     verifier supplies a date on approval, the row snaps into its
    //     correct season.
    whereAchieve.push(
      `(
        (a.event_date != '' AND a.event_date >= @startDate AND a.event_date < @endDate)
        OR
        (a.event_date = ''
          AND COALESCE(a.verified_at, a.created_at) >= @start
          AND COALESCE(a.verified_at, a.created_at) < @end)
      )`
    );
    whereParams.start = window.start;
    whereParams.end = window.end;
    whereParams.startDate = window.startDate;
    whereParams.endDate = window.endDate;
  }
  const joinCondition = whereAchieve.join(" AND ");

  const rows = db
    .prepare(
      `SELECT u.username, u.ign, u.squad, u.club_role, u.photo_data_url, u.games_json,
              u.certified_judge, u.professional_blader, u.pro_games_json,
              COALESCE(SUM(a.rank_points), 0) AS total_points,
              COALESCE(COUNT(a.id), 0) AS wins
         FROM users u
         LEFT JOIN achievements a
                ON a.username = u.username AND ${joinCondition}
        GROUP BY u.username
        ORDER BY total_points DESC, u.ign COLLATE NOCASE
        LIMIT 500`
    )
    .all(whereParams);
  const leaderboard = rows
    .map((r) => {
      let games = [];
      try {
        games = JSON.parse(r.games_json || "[]");
        if (!Array.isArray(games)) games = [];
      } catch (_) {
        games = [];
      }
      const proGames = readProGames(r);
      return {
        username: r.username,
        ign: r.ign,
        squad: r.squad,
        clubRole: r.club_role || "Member",
        photoDataUrl: r.photo_data_url || "",
        games,
        certifiedJudge: !!r.certified_judge,
        professionalBlader: proGames.includes("Beyblade X"),
        proGames,
        points: r.total_points || 0,
        wins: r.wins || 0,
      };
    })
    .filter((r) => r.points > 0 || r.wins > 0);

  // Dense-ranked placement so ties share the same rank.
  let prev = null;
  let rank = 0;
  let shown = 0;
  leaderboard.forEach((row) => {
    shown += 1;
    if (row.points !== prev) {
      rank = shown;
      prev = row.points;
    }
    row.rank = rank;
  });
  ok(res, {
    leaderboard,
    filters: {
      game: gameFilter || "all",
      season: window ? String((req.query && req.query.season) || "") : "all",
    },
    availableGames: ALLOWED_GAMES.slice(),
  });
});

function mapAchievement(r, opts) {
  const playerCount = r.player_count || 0;
  const poster = r.poster_data_url || "";
  const base = {
    id: r.id,
    username: r.username,
    // Blader name (IGN). Enriched via JOIN in the list/single-record
    // queries; the client renders this with the club-tag prefix.
    ign: r.user_ign || "",
    type: "achievement",
    eventName: r.event_name,
    // ISO YYYY-MM-DD string. '' for legacy rows submitted before the
    // required-date feature shipped — the verifier must supply one before
    // approving (enforced in PATCH).
    eventDate: r.event_date || "",
    game: r.game || "Beyblade X",
    rank: r.rank,
    rankCode: r.rank_code || "",
    placement: r.placement || 0,
    playerCount,
    isGrandTournament: isGrandTournament(playerCount),
    rankPoints: r.rank_points,
    challongeUrl: r.challonge_url,
    hasPoster: !!poster,
    status: r.status,
    verifierNote: r.verifier_note,
    createdAt: r.created_at,
    verifiedAt: r.verified_at,
    verifiedBy: r.verified_by,
  };
  // The poster is a base64 data URL that can run to hundreds of KB per row.
  // List endpoints return a slim view (see `lite` flag); single-record
  // endpoints return the full image so the verifier lightbox can display it.
  if (!opts || !opts.lite) {
    base.posterDataUrl = poster;
  }
  return base;
}

function mapJlap(r, opts) {
  const cert = r.certificate_data_url || "";
  const qr = r.qr_data_url || "";
  const base = {
    id: r.id,
    username: r.username,
    ign: r.user_ign || "",
    type: "jlap",
    hasCertificate: !!cert,
    hasQr: !!qr,
    status: r.status,
    verifierNote: r.verifier_note,
    createdAt: r.created_at,
    verifiedAt: r.verified_at,
    verifiedBy: r.verified_by,
  };
  if (!opts || !opts.lite) {
    base.certificateDataUrl = cert;
    base.qrDataUrl = qr;
  }
  return base;
}

function mapIdFlag(r) {
  const proGames = readProGames(r);
  return {
    id: r.id,
    username: r.username,
    ign: r.user_ign || "",
    type: "id_flags",
    certifiedJudge: !!r.certified_judge,
    professionalBlader: proGames.includes("Beyblade X"),
    proGames,
    status: r.status,
    verifierNote: r.verifier_note,
    createdAt: r.created_at,
    verifiedAt: r.verified_at,
    verifiedBy: r.verified_by,
  };
}

app.get("/api/achievements", requireAuth, (req, res) => {
  const role = req.user.role;
  let rows;
  // The JOIN surfaces the blader IGN so the verifier/admin UI can render
  // member names with the club-tag prefix instead of raw usernames.
  if (role === "verifier" || role === "admin") {
    rows = db
      .prepare(
        `SELECT a.*, u.ign AS user_ign
           FROM achievements a
           LEFT JOIN users u ON u.username = a.username
          ORDER BY a.created_at DESC`
      )
      .all();
  } else {
    rows = db
      .prepare(
        `SELECT a.*, u.ign AS user_ign
           FROM achievements a
           LEFT JOIN users u ON u.username = a.username
          WHERE a.username = ?
          ORDER BY a.created_at DESC`
      )
      .all(req.user.username);
  }
  ok(res, { achievements: rows.map((r) => mapAchievement(r, { lite: true })) });
});

// Single-record fetch. Returns the full poster data URL so the client can
// render it in a lightbox. Access: the owner can always read their own
// record; verifiers/admins can read any record.
app.get("/api/achievements/:id", requireAuth, (req, res) => {
  const id = String(req.params.id || "");
  const row = db
    .prepare(
      `SELECT a.*, u.ign AS user_ign
         FROM achievements a
         LEFT JOIN users u ON u.username = a.username
        WHERE a.id = ?`
    )
    .get(id);
  if (!row) return fail(res, 404, "Not found.");
  const role = req.user.role;
  const canSee =
    role === "admin" || role === "verifier" || row.username === req.user.username;
  if (!canSee) return fail(res, 403, "Forbidden.");
  ok(res, { achievement: mapAchievement(row) });
});

app.post("/api/achievements", requireAuth, (req, res) => {
  const b = req.body || {};
  const eventName = String(b.eventName || "").trim();
  const rankCode = String(b.rankCode || "").trim();
  const placement = Math.max(0, parseInt(b.placement, 10) || 0);
  const playerCount = Math.max(0, parseInt(b.playerCount, 10) || 0);
  const challongeUrl = String(b.challongeUrl || "").trim().slice(0, 512);
  const posterDataUrl = String(b.posterDataUrl || "").slice(0, MAX_POSTER_URL);
  const game = normalizeGame(b.game);
  const eventDate = normalizeEventDate(b.eventDate);

  if (!eventName || eventName.length > 160) {
    return fail(res, 400, "Event name is required (max 160 chars).");
  }
  if (!eventDate) {
    return fail(
      res,
      400,
      "Event date is required (use the calendar picker, on or before today)."
    );
  }
  // JLAP / Certified-Judge activities live in their own queue with their
  // own artifact (certificate + QR). Bouncing them here keeps the
  // tournament/leaderboard pipeline clean and guides the member to the
  // right form on their dashboard.
  if (eventLooksLikeJlap(eventName)) {
    return fail(
      res,
      400,
      'This looks like a Judge Like a Pro / Certified Judge submission. Please submit it under "JLAP" on your dashboard instead of Achievements.'
    );
  }
  if (!RANK_CODES[rankCode]) {
    return fail(res, 400, "Unknown rank.");
  }
  if (rankCode === "podium" && placement < 4) {
    return fail(
      res,
      400,
      "Podium submissions must use placement 4 or higher (4th, 5th, 6th…)."
    );
  }
  if (!playerCount || playerCount < 2 || playerCount > 4096) {
    return fail(res, 400, "Player count is required (2–4096).");
  }

  const rankPoints = computeAchievementPoints(rankCode, placement, playerCount);
  const rankLabel = rankDisplay(rankCode, placement);

  const pending = db
    .prepare(
      `SELECT COUNT(*) AS c FROM achievements WHERE username = ? AND status = 'pending'`
    )
    .get(req.user.username).c;
  if (pending >= MAX_PENDING_ACHIEVEMENTS_PER_USER) {
    return fail(
      res,
      429,
      "You already have the maximum number of pending achievements under review."
    );
  }

  const row = {
    id: uid("ach_"),
    username: req.user.username,
    event_name: eventName,
    event_date: eventDate,
    rank: rankLabel,
    rank_code: rankCode,
    placement: rankCode === "podium" ? placement : 0,
    player_count: playerCount,
    rank_points: rankPoints,
    challonge_url: challongeUrl,
    poster_data_url: posterDataUrl,
    game,
    status: "pending",
    verifier_note: "",
    created_at: Date.now(),
    verified_at: null,
    verified_by: null,
  };
  db.prepare(
    `INSERT INTO achievements (
      id, username, event_name, event_date, rank, rank_code, placement, player_count,
      rank_points, challonge_url, poster_data_url, game, status, verifier_note,
      created_at, verified_at, verified_by
    ) VALUES (@id, @username, @event_name, @event_date, @rank, @rank_code, @placement,
              @player_count, @rank_points, @challonge_url, @poster_data_url,
              @game, @status, @verifier_note, @created_at, @verified_at, @verified_by)`
  ).run(row);
  ok(res, { achievement: mapAchievement(row) });
});

app.patch("/api/achievements/:id", requireRole("verifier"), (req, res) => {
  const id = req.params.id;
  const b = req.body || {};
  const existing = db
    .prepare(`SELECT * FROM achievements WHERE id = ?`)
    .get(id);
  if (!existing) return fail(res, 404, "Not found.");

  const status =
    b.status === "verified" || b.status === "rejected" ? b.status : null;
  const note = typeof b.verifierNote === "string"
    ? b.verifierNote.trim().slice(0, 1000)
    : "";
  if (!status) return fail(res, 400, "status must be verified or rejected.");
  if (status === "rejected" && !note) {
    return fail(res, 400, "Reject requires a verifier note.");
  }

  // Verifiers can't approve their own submissions.
  if (existing.username === req.user.username) {
    return fail(res, 403, "You can't verify your own submission.");
  }

  // Event date handling. New submissions already carry a date; legacy rows
  // (migrated before the required-date feature) have event_date = '' and the
  // verifier MUST supply one before approving. The verifier may also correct
  // an existing date if the member typo'd — server trusts the verifier role.
  let eventDate = existing.event_date || "";
  if (b.eventDate != null) {
    const normalized = normalizeEventDate(b.eventDate);
    if (!normalized) {
      return fail(
        res,
        400,
        "Event date must be a valid calendar date (YYYY-MM-DD) on or before today."
      );
    }
    eventDate = normalized;
  }
  if (status === "verified" && !eventDate) {
    return fail(
      res,
      400,
      "Please fill in the date of the event before approving this submission."
    );
  }

  // Always recompute the point delta from the server-side scoring engine.
  // For legacy rows stored before the scoring migration (no rank_code), fall
  // back to the legacy per-label table so pending verifications still resolve.
  const canonicalPoints = existing.rank_code
    ? computeAchievementPoints(
        existing.rank_code,
        existing.placement,
        existing.player_count
      )
    : LEGACY_RANK_POINTS[existing.rank] || 0;
  const pointsDelta =
    status === "verified" && existing.status !== "verified"
      ? canonicalPoints
      : 0;

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE achievements
          SET status = ?, rank_points = ?, verifier_note = ?, verified_at = ?, verified_by = ?, event_date = ?
        WHERE id = ?`
    ).run(
      status,
      canonicalPoints,
      note || (status === "verified" ? "Approved" : ""),
      Date.now(),
      req.user.username,
      eventDate,
      id
    );
    if (pointsDelta) {
      db.prepare(
        `UPDATE users SET points = points + ? WHERE username = ?`
      ).run(pointsDelta, existing.username);
    }
  });
  tx();

  auditLog(
    req.user.username,
    "achievement." + status,
    id,
    { member: existing.username, rank: existing.rank, points: canonicalPoints },
    req.clientIp
  );

  if (existing.status !== status) {
    if (status === "verified") {
      notify(
        existing.username,
        "achievement",
        "Achievement approved",
        'Your result "' +
          existing.event_name +
          '" was verified by ' +
          req.user.username +
          ". +" +
          canonicalPoints +
          " pts.",
        "dashboard.html"
      );
    } else if (status === "rejected") {
      notify(
        existing.username,
        "achievement",
        "Achievement needs changes",
        'Your result "' +
          existing.event_name +
          '" was rejected by ' +
          req.user.username +
          (note ? ". Note: " + note : "."),
        "dashboard.html"
      );
    }
  }

  const updated = db.prepare(`SELECT * FROM achievements WHERE id = ?`).get(id);
  ok(res, { achievement: mapAchievement(updated) });
});

// Backfill the event_date on an already-verified achievement. Exists because
// many achievements were verified before the required-date feature shipped,
// and the leaderboard/portfolio can't bucket them into the right season
// until the verifier fills in the missing date. Only verifiers can call this
// endpoint; it never changes status (the row stays verified) and only
// mutates the event_date column (plus an audit-log entry + a courtesy
// notification to the blader).
app.patch(
  "/api/achievements/:id/event-date",
  requireRole("verifier"),
  (req, res) => {
    const id = req.params.id;
    const b = req.body || {};
    const existing = db
      .prepare(`SELECT * FROM achievements WHERE id = ?`)
      .get(id);
    if (!existing) return fail(res, 404, "Not found.");
    if (existing.status !== "verified") {
      return fail(
        res,
        400,
        "This endpoint only updates dates on already-verified achievements. Use the normal Verify action for pending submissions."
      );
    }
    const normalized = normalizeEventDate(b.eventDate);
    if (!normalized) {
      return fail(
        res,
        400,
        "Event date must be a valid calendar date (YYYY-MM-DD) on or before today."
      );
    }
    if (existing.event_date === normalized) {
      // No-op but succeed so the client doesn't surface a scary error on a
      // double-click; return the row unchanged.
      return ok(res, { achievement: mapAchievement(existing) });
    }

    db.prepare(
      `UPDATE achievements SET event_date = ? WHERE id = ?`
    ).run(normalized, id);

    auditLog(
      req.user.username,
      "achievement.date_backfill",
      id,
      {
        member: existing.username,
        event: existing.event_name,
        previous_date: existing.event_date || "",
        new_date: normalized,
      },
      req.clientIp
    );

    // Only notify when we were genuinely backfilling a blank date. Correcting
    // a typo the blader never saw doesn't need an inbox ping.
    if (!existing.event_date) {
      notify(
        existing.username,
        "achievement",
        "Achievement date confirmed",
        'The event date for "' +
          existing.event_name +
          '" was set to ' +
          normalized +
          " by " +
          req.user.username +
          ". Your points now count toward the correct season.",
        "dashboard.html"
      );
    }

    const updated = db
      .prepare(`SELECT * FROM achievements WHERE id = ?`)
      .get(id);
    ok(res, { achievement: mapAchievement(updated) });
  }
);

app.get("/api/jlap", requireAuth, (req, res) => {
  const role = req.user.role;
  let rows;
  if (role === "verifier" || role === "admin") {
    rows = db
      .prepare(
        `SELECT j.*, u.ign AS user_ign
           FROM jlap_submissions j
           LEFT JOIN users u ON u.username = j.username
          ORDER BY j.created_at DESC`
      )
      .all();
  } else {
    rows = db
      .prepare(
        `SELECT j.*, u.ign AS user_ign
           FROM jlap_submissions j
           LEFT JOIN users u ON u.username = j.username
          WHERE j.username = ?
          ORDER BY j.created_at DESC`
      )
      .all(req.user.username);
  }
  // Slim response; full certificate/QR fetched per-id on demand.
  ok(res, { jlap: rows.map((r) => mapJlap(r, { lite: true })) });
});

app.get("/api/jlap/:id", requireAuth, (req, res) => {
  const id = String(req.params.id || "");
  const row = db
    .prepare(
      `SELECT j.*, u.ign AS user_ign
         FROM jlap_submissions j
         LEFT JOIN users u ON u.username = j.username
        WHERE j.id = ?`
    )
    .get(id);
  if (!row) return fail(res, 404, "Not found.");
  const role = req.user.role;
  const canSee =
    role === "admin" || role === "verifier" || row.username === req.user.username;
  if (!canSee) return fail(res, 403, "Forbidden.");
  ok(res, { jlap: mapJlap(row) });
});

app.post("/api/jlap", requireAuth, (req, res) => {
  const b = req.body || {};
  const cert = String(b.certificateDataUrl || "").slice(0, MAX_CERT_URL);
  const qr = String(b.qrDataUrl || "").slice(0, MAX_QR_URL);
  if (!cert || !qr) {
    return fail(res, 400, "Certificate and QR are both required.");
  }

  const pending = db
    .prepare(
      `SELECT COUNT(*) AS c FROM jlap_submissions WHERE username = ? AND status = 'pending'`
    )
    .get(req.user.username).c;
  if (pending >= MAX_PENDING_JLAP_PER_USER) {
    return fail(res, 429, "You already have a pending JLAP submission.");
  }

  const row = {
    id: uid("jlap_"),
    username: req.user.username,
    certificate_data_url: cert,
    qr_data_url: qr,
    status: "pending",
    verifier_note: "",
    created_at: Date.now(),
    verified_at: null,
    verified_by: null,
  };
  db.prepare(
    `INSERT INTO jlap_submissions (
      id, username, certificate_data_url, qr_data_url, status,
      verifier_note, created_at, verified_at, verified_by
    ) VALUES (@id, @username, @certificate_data_url, @qr_data_url, @status,
              @verifier_note, @created_at, @verified_at, @verified_by)`
  ).run(row);
  ok(res, { jlap: mapJlap(row) });
});

app.patch("/api/jlap/:id", requireRole("verifier"), (req, res) => {
  const id = req.params.id;
  const b = req.body || {};
  const existing = db
    .prepare(`SELECT * FROM jlap_submissions WHERE id = ?`)
    .get(id);
  if (!existing) return fail(res, 404, "Not found.");
  if (existing.username === req.user.username) {
    return fail(res, 403, "You can't verify your own submission.");
  }
  const status =
    b.status === "verified" || b.status === "rejected" ? b.status : null;
  const note = typeof b.verifierNote === "string"
    ? b.verifierNote.trim().slice(0, 1000)
    : "";
  if (!status) return fail(res, 400, "status must be verified or rejected.");
  if (status === "rejected" && !note) {
    return fail(res, 400, "Reject requires a verifier note.");
  }
  db.prepare(
    `UPDATE jlap_submissions
        SET status = ?, verifier_note = ?, verified_at = ?, verified_by = ?
      WHERE id = ?`
  ).run(
    status,
    note || (status === "verified" ? "JLAP verified" : ""),
    Date.now(),
    req.user.username,
    id
  );
  auditLog(
    req.user.username,
    "jlap." + status,
    id,
    { member: existing.username },
    req.clientIp
  );
  if (existing.status !== status) {
    if (status === "verified") {
      notify(
        existing.username,
        "jlap",
        "JLAP approved",
        "Your JLAP certificate was verified by " + req.user.username + ".",
        "dashboard.html"
      );
    } else if (status === "rejected") {
      notify(
        existing.username,
        "jlap",
        "JLAP needs changes",
        "Your JLAP certificate was rejected by " +
          req.user.username +
          (note ? ". Note: " + note : "."),
        "dashboard.html"
      );
    }
  }
  const updated = db
    .prepare(`SELECT * FROM jlap_submissions WHERE id = ?`)
    .get(id);
  ok(res, { jlap: mapJlap(updated) });
});

app.get("/api/id-flags/me", requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT * FROM id_flag_requests WHERE username = ? ORDER BY created_at DESC`
    )
    .all(req.user.username);
  const pending = rows.find((r) => r.status === "pending") || null;
  const latest = rows[0] || null;
  const currentProGames = readProGames(req.user);
  ok(res, {
    verified: {
      certifiedJudge: !!req.user.certified_judge,
      professionalBlader: currentProGames.includes("Beyblade X"),
      proGames: currentProGames,
    },
    pending: pending ? mapIdFlag(pending) : null,
    latest: latest ? mapIdFlag(latest) : null,
    history: rows.map(mapIdFlag),
  });
});

app.post("/api/id-flags/request", requireAuth, (req, res) => {
  const b = req.body || {};
  const wantCj = !!b.certifiedJudge;

  // Accept either the new `proGames` list OR the legacy `professionalBlader`
  // boolean so older clients that only know about Beyblade X still work.
  // When both are supplied, the array wins.
  let wantProGames;
  if (Array.isArray(b.proGames)) {
    wantProGames = normalizeProGames(b.proGames);
  } else {
    const currentPro = readProGames(req.user);
    // Strip Beyblade X, then add it back only if the legacy bool asks for it.
    wantProGames = currentPro.filter((g) => g !== "Beyblade X");
    if (b.professionalBlader) wantProGames.unshift("Beyblade X");
    wantProGames = normalizeProGames(wantProGames);
  }

  const currentProGames = readProGames(req.user);
  if (
    wantCj === !!req.user.certified_judge &&
    proGamesEqual(wantProGames, currentProGames)
  ) {
    return fail(res, 400, "No change from your current approved ID flags.");
  }

  const pending = db
    .prepare(
      `SELECT id FROM id_flag_requests WHERE username = ? AND status = 'pending'`
    )
    .get(req.user.username);
  if (pending) {
    return fail(res, 409, "You already have a pending ID flags request.");
  }

  const row = {
    id: uid("idf_"),
    username: req.user.username,
    certified_judge: wantCj ? 1 : 0,
    professional_blader: wantProGames.includes("Beyblade X") ? 1 : 0,
    pro_games_json: JSON.stringify(wantProGames),
    status: "pending",
    verifier_note: "",
    created_at: Date.now(),
    verified_at: null,
    verified_by: null,
  };
  db.prepare(
    `INSERT INTO id_flag_requests (
      id, username, certified_judge, professional_blader, pro_games_json, status,
      verifier_note, created_at, verified_at, verified_by
    ) VALUES (@id, @username, @certified_judge, @professional_blader, @pro_games_json, @status,
              @verifier_note, @created_at, @verified_at, @verified_by)`
  ).run(row);
  ok(res, { request: mapIdFlag(row) });
});

app.get("/api/id-flags/pending", requireRole("verifier"), (_req, res) => {
  const rows = db
    .prepare(
      `SELECT f.*, u.ign AS user_ign
         FROM id_flag_requests f
         LEFT JOIN users u ON u.username = f.username
        WHERE f.status = 'pending'
        ORDER BY f.created_at ASC`
    )
    .all();
  ok(res, { requests: rows.map(mapIdFlag) });
});

app.patch("/api/id-flags/:id", requireRole("verifier"), (req, res) => {
  const id = req.params.id;
  const b = req.body || {};
  const existing = db
    .prepare(`SELECT * FROM id_flag_requests WHERE id = ?`)
    .get(id);
  if (!existing) return fail(res, 404, "Not found.");
  if (existing.username === req.user.username) {
    return fail(res, 403, "You can't verify your own submission.");
  }
  const status =
    b.status === "verified" || b.status === "rejected" ? b.status : null;
  const note = typeof b.verifierNote === "string"
    ? b.verifierNote.trim().slice(0, 1000)
    : "";
  if (!status) return fail(res, 400, "status must be verified or rejected.");
  if (status === "rejected" && !note) {
    return fail(res, 400, "Reject requires a verifier note.");
  }

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE id_flag_requests
          SET status = ?, verifier_note = ?, verified_at = ?, verified_by = ?
        WHERE id = ?`
    ).run(
      status,
      note || "Approved",
      Date.now(),
      req.user.username,
      id
    );
    if (status === "verified") {
      const approvedProGames = readProGames(existing);
      db.prepare(
        `UPDATE users
            SET certified_judge = ?,
                professional_blader = ?,
                pro_games_json = ?
          WHERE username = ?`
      ).run(
        existing.certified_judge ? 1 : 0,
        approvedProGames.includes("Beyblade X") ? 1 : 0,
        JSON.stringify(approvedProGames),
        existing.username
      );
    }
  });
  tx();

  const approvedProGames = readProGames(existing);
  auditLog(
    req.user.username,
    "idflags." + status,
    id,
    {
      member: existing.username,
      certifiedJudge: !!existing.certified_judge,
      professionalBlader: approvedProGames.includes("Beyblade X"),
      proGames: approvedProGames,
    },
    req.clientIp
  );

  if (existing.status !== status) {
    if (status === "verified") {
      notify(
        existing.username,
        "idflags",
        "ID flags updated",
        "Your ID flag request was approved by " +
          req.user.username +
          ". Your digital ID has been updated.",
        "dashboard.html"
      );
    } else if (status === "rejected") {
      notify(
        existing.username,
        "idflags",
        "ID flag request rejected",
        "Your ID flag request was rejected by " +
          req.user.username +
          (note ? ". Note: " + note : "."),
        "dashboard.html"
      );
    }
  }

  const updated = db
    .prepare(`SELECT * FROM id_flag_requests WHERE id = ?`)
    .get(id);
  ok(res, { request: mapIdFlag(updated) });
});

// --------------------------------------------------------------------------
// Site customization (public read, admin write)
// --------------------------------------------------------------------------

const SITE_SANITIZE = {
  allowedTags: [
    "h1", "h2", "h3", "h4", "p", "ul", "ol", "li", "strong", "em", "b", "i",
    "span", "div", "br", "hr", "img", "a", "figure", "figcaption", "small",
    "table", "thead", "tbody", "tr", "th", "td",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "width", "height"],
    "*": ["class"],
  },
  allowedSchemes: ["http", "https", "mailto", "data"],
  allowedSchemesByTag: { img: ["http", "https", "data"] },
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", {
      target: "_blank",
      rel: "noopener noreferrer",
    }),
  },
};

app.get("/api/site", (_req, res) => {
  const row = db
    .prepare(`SELECT data_json FROM site_custom WHERE id = 1`)
    .get();
  let data = {};
  try {
    data = JSON.parse(row.data_json || "{}");
  } catch (_) {
    data = {};
  }
  // Fill in the club tag default so clients always see a value.
  if (typeof data.clubTag !== "string" || !data.clubTag.trim()) {
    data.clubTag = DEFAULT_CLUB_TAG;
  }
  ok(res, { site: data });
});

app.put("/api/admin/site", requireRole("admin"), (req, res) => {
  const body = req.body || {};
  const next = {};

  const strMax = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

  if (typeof body.footerNote === "string") {
    next.footerNote = strMax(body.footerNote, 500);
  }
  if (typeof body.headerTagline === "string") {
    next.headerTagline = strMax(body.headerTagline, 200);
  }
  if (typeof body.headCaptain === "string") {
    next.headCaptain = strMax(body.headCaptain, 120);
  }
  if (typeof body.orgChartHtml === "string") {
    next.orgChartHtml = sanitizeHtml(
      strMax(body.orgChartHtml, 20_000),
      SITE_SANITIZE
    );
  }
  if (typeof body.brandMarkDataUrl === "string") {
    // Only accept image data URLs; cap size.
    const v = body.brandMarkDataUrl;
    if (!v || /^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,/.test(v)) {
      next.brandMarkDataUrl = v.slice(0, MAX_PHOTO_URL);
    }
  }
  if (Array.isArray(body.extraNav)) {
    next.extraNav = body.extraNav
      .slice(0, 20)
      .map((item) => ({
        label: strMax(item && item.label, 60),
        href: strMax(item && item.href, 500),
        external: !!(item && item.external),
      }))
      .filter((it) => it.label && /^https?:\/\//i.test(it.href));
  }
  if (Array.isArray(body.gamesExtra)) {
    next.gamesExtra = body.gamesExtra
      .slice(0, 40)
      .map((g) => strMax(String(g || ""), 60))
      .filter(Boolean);
  }
  // Club tag prepended to blader names on public surfaces. Short, ASCII-ish,
  // admin-managed. Empty string is allowed and means "no prefix".
  if (typeof body.clubTag === "string") {
    // Collapse internal whitespace and cap length — keeps display compact.
    const tag = body.clubTag.trim().replace(/\s+/g, " ");
    next.clubTag = tag.slice(0, 24);
  }

  db.prepare(
    `UPDATE site_custom SET data_json = ?, updated_at = ? WHERE id = 1`
  ).run(JSON.stringify(next), Date.now());

  auditLog(
    req.user.username,
    "site.update",
    null,
    { keys: Object.keys(next) },
    req.clientIp
  );

  ok(res, { site: next });
});

// --------------------------------------------------------------------------
// Admin member management
// --------------------------------------------------------------------------

app.get("/api/admin/members", requireRole("admin"), (_req, res) => {
  const rows = db
    .prepare(
      `SELECT username, role, ign, real_name, squad, club_role, points, created_at,
              certified_judge, professional_blader, pro_games_json
         FROM users ORDER BY created_at ASC`
    )
    .all();
  ok(res, {
    members: rows.map((r) => {
      const proGames = readProGames(r);
      return {
        username: r.username,
        role: r.role,
        ign: r.ign,
        realName: r.real_name,
        squad: r.squad,
        clubRole: r.club_role,
        points: r.points,
        createdAt: r.created_at,
        certifiedJudge: !!r.certified_judge,
        professionalBlader: proGames.includes("Beyblade X"),
        proGames,
      };
    }),
  });
});

app.get("/api/admin/members/:username", requireRole("admin"), (req, res) => {
  const username = normUser(req.params.username);
  const user = getUserByUsername(username);
  if (!user) return fail(res, 404, "Not found.");

  const ach = db
    .prepare(
      `SELECT * FROM achievements WHERE username = ? ORDER BY created_at DESC`
    )
    .all(username);
  const jl = db
    .prepare(
      `SELECT * FROM jlap_submissions WHERE username = ? ORDER BY created_at DESC`
    )
    .all(username);
  const idf = db
    .prepare(
      `SELECT * FROM id_flag_requests WHERE username = ? ORDER BY created_at DESC`
    )
    .all(username);

  function tally(list) {
    return list.reduce(
      (acc, r) => {
        acc[r.status] = (acc[r.status] || 0) + 1;
        return acc;
      },
      { pending: 0, verified: 0, rejected: 0 }
    );
  }

  ok(res, {
    profile: profileFromRow(user),
    submissions: {
      achievements: tally(ach),
      jlap: tally(jl),
      idFlags: tally(idf),
    },
    recent: {
      achievements: ach.slice(0, 10).map(mapAchievement),
      jlap: jl.slice(0, 10).map(mapJlap),
      idFlags: idf.slice(0, 10).map(mapIdFlag),
    },
  });
});

app.post("/api/admin/members", requireRole("admin"), async (req, res) => {
  const b = req.body || {};
  const username = normUser(b.username);
  const password = String(b.password || "");
  const role = ["user", "verifier", "admin"].includes(b.role) ? b.role : "user";
  const ign = String(b.ign || "").trim();
  const realName = String(b.realName || "").trim();
  const squad = String(b.squad || "").trim();
  // Club role is a strict enum (Founder, Head Captain, Captain, Vice Captain,
  // Member). Unknown values collapse to Member via normalizeClubRole().
  const clubRole = normalizeClubRole(b.clubRole, "Member");
  let games = b.games;
  if (!Array.isArray(games)) games = [];
  games = games.map((g) => String(g || "").trim()).filter(Boolean);
  if (!games.length) games = ["Beyblade X"];

  // PRO flags: accept either the multi-game array or (legacy) boolean. The
  // boolean seeds Beyblade X only so older admin clients still behave.
  let proGames = normalizeProGames(b.proGames);
  if (!Array.isArray(b.proGames) && b.professionalBlader) {
    proGames = ["Beyblade X"];
  }
  const certifiedJudge = !!b.certifiedJudge;

  if (!/^[a-z0-9_]{3,32}$/.test(username)) {
    return fail(res, 400, "Invalid username.");
  }
  const policyErr = passwordPolicyError(password, username);
  if (policyErr) return fail(res, 400, policyErr);
  if (!ign) return fail(res, 400, "IGN is required.");
  if (ignContainsClubTag(ign)) {
    return fail(
      res,
      400,
      `Blader name must not contain the club tag "${getCurrentClubTag()}" — it is added automatically.`
    );
  }
  if (getUserByUsername(username)) {
    return fail(res, 409, "That username is already taken.");
  }

  const { hash, salt, kdf } = await hashPassword(password);
  db.prepare(
    `INSERT INTO users (
      username, password_hash, password_salt, password_kdf,
      role, ign, real_name, squad, club_role, games_json,
      photo_data_url, certified_judge, professional_blader, pro_games_json,
      points, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, 0, ?)`
  ).run(
    username,
    hash,
    salt,
    kdf,
    role,
    ign,
    realName || ign,
    squad || "Garuda Games",
    clubRole,
    JSON.stringify(games),
    certifiedJudge ? 1 : 0,
    proGames.includes("Beyblade X") ? 1 : 0,
    JSON.stringify(proGames),
    Date.now()
  );

  auditLog(
    req.user.username,
    "admin.member.create",
    username,
    { role, clubRole },
    req.clientIp
  );

  const created = getUserByUsername(username);
  ok(res, { member: profileFromRow(created) });
});

app.patch("/api/admin/members/:username", requireRole("admin"), async (req, res) => {
  const username = normUser(req.params.username);
  const existing = getUserByUsername(username);
  if (!existing) return fail(res, 404, "Not found.");
  const b = req.body || {};
  const patch = {};
  let roleChanged = false;
  let passwordChanged = false;

  if (["user", "verifier", "admin"].includes(b.role) && b.role !== existing.role) {
    patch.role = b.role;
    roleChanged = true;
  }
  if (typeof b.ign === "string" && b.ign.trim()) {
    const newIgn = b.ign.trim().slice(0, 64);
    if (ignContainsClubTag(newIgn)) {
      return fail(
        res,
        400,
        `Blader name must not contain the club tag "${getCurrentClubTag()}" — it is added automatically.`
      );
    }
    patch.ign = newIgn;
  }
  if (typeof b.realName === "string") {
    patch.real_name = b.realName.trim().slice(0, 128);
  }
  if (typeof b.squad === "string") {
    patch.squad = b.squad.trim().slice(0, 64);
  }
  // Club role — validated against the Captain/Vice Captain/Member enum.
  let clubRoleChanged = false;
  let newClubRole = null;
  if (b.clubRole != null) {
    newClubRole = normalizeClubRole(b.clubRole, existing.club_role || "Member");
    if (newClubRole !== existing.club_role) {
      patch.club_role = newClubRole;
      clubRoleChanged = true;
    }
  }
  if (Array.isArray(b.games)) {
    const games = b.games.map((g) => String(g || "").trim()).filter(Boolean);
    patch.games_json = JSON.stringify(games.length ? games : ["Beyblade X"]);
  }
  // Admin-direct edit of the ID-flag booleans. Members can only request
  // changes via /api/id-flags/request; admins can set them outright.
  if (b.certifiedJudge != null) {
    patch.certified_judge = b.certifiedJudge ? 1 : 0;
  }
  // Multi-game PRO flags. Accept `proGames: string[]` as the canonical
  // payload, or fall back to the legacy boolean which only toggles PRO
  // Beyblade X and leaves the rest of the list intact.
  if (Array.isArray(b.proGames)) {
    const nextPro = normalizeProGames(b.proGames);
    patch.pro_games_json = JSON.stringify(nextPro);
    patch.professional_blader = nextPro.includes("Beyblade X") ? 1 : 0;
  } else if (b.professionalBlader != null) {
    const current = readProGames(existing).filter((g) => g !== "Beyblade X");
    if (b.professionalBlader) current.unshift("Beyblade X");
    const nextPro = normalizeProGames(current);
    patch.pro_games_json = JSON.stringify(nextPro);
    patch.professional_blader = nextPro.includes("Beyblade X") ? 1 : 0;
  }
  if (b.points != null) {
    const pts = Math.max(0, parseInt(b.points, 10) || 0);
    patch.points = pts;
  }
  if (typeof b.password === "string" && b.password.length) {
    const policyErr = passwordPolicyError(b.password, existing.username);
    if (policyErr) return fail(res, 400, policyErr);
    const h = await hashPassword(b.password);
    patch.password_hash = h.hash;
    patch.password_salt = h.salt;
    patch.password_kdf = h.kdf;
    passwordChanged = true;
  }

  const keys = Object.keys(patch);
  if (!keys.length) return ok(res, { member: profileFromRow(existing) });

  if (patch.role && existing.role === "admin" && patch.role !== "admin") {
    const adminCount = db
      .prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin'`)
      .get().c;
    if (adminCount <= 1) {
      return fail(res, 400, "Cannot demote the last admin.");
    }
  }

  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE users SET ${sets} WHERE username = @username`).run({
    ...patch,
    username,
  });

  // Any role change or password change invalidates existing sessions so a
  // demoted admin (or a user whose password was reset) loses access immediately.
  if (roleChanged || passwordChanged) {
    destroyAllSessionsFor(username);
  }

  auditLog(
    req.user.username,
    "admin.member.update",
    username,
    {
      fields: keys.filter((k) => !k.startsWith("password_")),
      passwordChanged,
      roleChanged,
      newRole: patch.role || null,
      clubRoleChanged,
      oldClubRole: clubRoleChanged ? existing.club_role : undefined,
      newClubRole: clubRoleChanged ? newClubRole : undefined,
    },
    req.clientIp
  );

  const updated = getUserByUsername(username);
  ok(res, { member: profileFromRow(updated) });
});

app.delete("/api/admin/members/:username", requireRole("admin"), (req, res) => {
  const username = normUser(req.params.username);
  if (username === req.user.username) {
    return fail(res, 400, "You cannot delete your own account.");
  }
  const target = getUserByUsername(username);
  if (!target) return fail(res, 404, "Not found.");
  if (target.role === "admin") {
    const adminCount = db
      .prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin'`)
      .get().c;
    if (adminCount <= 1) {
      return fail(res, 400, "Cannot delete the last admin.");
    }
  }
  db.prepare(`DELETE FROM users WHERE username = ?`).run(username);
  destroyAllSessionsFor(username);

  auditLog(
    req.user.username,
    "admin.member.delete",
    username,
    { role: target.role },
    req.clientIp
  );

  ok(res, {});
});

app.get("/api/admin/backup", requireRole("admin"), (_req, res) => {
  const users = db
    .prepare(
      `SELECT username, role, ign, real_name, squad, club_role, games_json,
              certified_judge, professional_blader, pro_games_json,
              points, created_at
         FROM users`
    )
    .all();
  const ach = db.prepare(`SELECT * FROM achievements`).all();
  const jlap = db.prepare(`SELECT * FROM jlap_submissions`).all();
  const idf = db.prepare(`SELECT * FROM id_flag_requests`).all();
  const site = db
    .prepare(`SELECT data_json FROM site_custom WHERE id = 1`)
    .get();
  res.json({
    ok: true,
    exportedAt: Date.now(),
    users,
    achievements: ach,
    jlap,
    idFlagRequests: idf,
    site: site ? JSON.parse(site.data_json || "{}") : {},
  });
});

app.get("/api/admin/audit", requireRole("admin"), (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const before = parseInt(req.query.before, 10) || 0;
  const actionFilter = String(req.query.action || "").trim().toLowerCase();
  const actorFilter = String(req.query.actor || "").trim().toLowerCase();
  const targetFilter = String(req.query.target || "").trim().toLowerCase();
  const sinceTs = parseInt(req.query.since, 10) || 0;

  const where = [];
  const params = {};
  if (before > 0) {
    where.push("id < @before");
    params.before = before;
  }
  if (actionFilter) {
    where.push("LOWER(action) LIKE @action");
    params.action = "%" + actionFilter + "%";
  }
  if (actorFilter) {
    where.push("LOWER(actor) LIKE @actor");
    params.actor = "%" + actorFilter + "%";
  }
  if (targetFilter) {
    where.push("LOWER(COALESCE(target, '')) LIKE @target");
    params.target = "%" + targetFilter + "%";
  }
  if (sinceTs > 0) {
    where.push("created_at >= @since");
    params.since = sinceTs;
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  params.limit = limit;

  const rows = db
    .prepare(
      `SELECT id, actor, action, target, detail_json, ip, created_at
         FROM audit_log ${whereSql} ORDER BY id DESC LIMIT @limit`
    )
    .all(params);

  // Distinct action list (for filter dropdown) - capped to keep cheap.
  const actionsRows = db
    .prepare(
      `SELECT DISTINCT action FROM audit_log ORDER BY action LIMIT 200`
    )
    .all();

  const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM audit_log`).get();

  ok(res, {
    entries: rows.map((r) => ({
      id: r.id,
      actor: r.actor,
      action: r.action,
      target: r.target,
      detail: safeJson(r.detail_json),
      ip: r.ip,
      createdAt: r.created_at,
    })),
    nextBefore: rows.length === limit ? rows[rows.length - 1].id : null,
    total: totalRow ? totalRow.c : 0,
    actions: actionsRows.map((r) => r.action),
  });
});

function safeJson(s) {
  try {
    return JSON.parse(s || "{}");
  } catch (_) {
    return {};
  }
}

// --------------------------------------------------------------------------
// News / "What's new" feed
// --------------------------------------------------------------------------

// Narrow HTML allowlist for news bodies. Admins write user-friendly release
// notes; this keeps the formatting options helpful (lists, emphasis, links)
// without opening the door to script / style / iframe injection.
const NEWS_SANITIZE = {
  allowedTags: [
    "p",
    "br",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "ul",
    "ol",
    "li",
    "a",
    "code",
    "blockquote",
    "h3",
    "h4",
  ],
  allowedAttributes: {
    a: ["href", "target", "rel"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", {
      target: "_blank",
      rel: "noopener noreferrer",
    }),
  },
};

const NEWS_CATEGORIES = Object.freeze([
  "update",
  "feature",
  "fix",
  "announcement",
  "event",
  "release",
  "security",
]);

function normalizeNewsCategory(v) {
  const c = String(v || "update").toLowerCase().trim();
  return NEWS_CATEGORIES.indexOf(c) >= 0 ? c : "update";
}

function serializeNewsRow(r) {
  return {
    id: r.id,
    title: r.title,
    summary: r.summary,
    body: r.body,
    category: r.category,
    version: r.version,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    pinned: !!r.pinned,
    published: !!r.published,
  };
}

// Non-throwing session lookup so public endpoints can tell whether the caller
// happens to be an admin (to surface drafts) without rejecting anonymous
// visitors.
function tryLoadUser(req) {
  const sid = req.cookies && req.cookies[COOKIE_NAME];
  if (!sid) return null;
  const s = getSession(sid);
  if (!s) return null;
  return getUserByUsername(s.username);
}

// Public: anyone (logged-in or not) can read the list. Drafts are hidden
// unless an authenticated admin passes ?drafts=1.
app.get("/api/news", (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
  const viewer = tryLoadUser(req);
  const includeDrafts =
    viewer && viewer.role === "admin" && req.query.drafts === "1";
  const where = includeDrafts ? "" : "WHERE published = 1";
  const rows = db
    .prepare(
      `SELECT id, title, summary, body, category, version, created_by,
              created_at, updated_at, pinned, published
         FROM news_posts
         ${where}
         ORDER BY pinned DESC, created_at DESC
         LIMIT ?`
    )
    .all(limit);

  // Newest post timestamp is exposed so clients can show a "NEW" dot in the
  // nav when it's ahead of their locally stored "last viewed" time.
  const latestRow = db
    .prepare(
      `SELECT MAX(created_at) AS t FROM news_posts WHERE published = 1`
    )
    .get();

  ok(res, {
    news: rows.map(serializeNewsRow),
    latestAt: latestRow && latestRow.t ? latestRow.t : 0,
  });
});

app.get("/api/news/:id", (req, res) => {
  const row = db
    .prepare(
      `SELECT id, title, summary, body, category, version, created_by,
              created_at, updated_at, pinned, published
         FROM news_posts WHERE id = ?`
    )
    .get(req.params.id);
  if (!row) return fail(res, 404, "Not found.");
  if (!row.published) {
    const viewer = tryLoadUser(req);
    if (!viewer || viewer.role !== "admin") return fail(res, 404, "Not found.");
  }
  ok(res, { post: serializeNewsRow(row) });
});

function readNewsPayload(body) {
  const title = String((body && body.title) || "").trim().slice(0, 160);
  const summary = String((body && body.summary) || "").trim().slice(0, 400);
  const rawBody = String((body && body.body) || "").slice(0, 20_000);
  const cleanBody = sanitizeHtml(rawBody, NEWS_SANITIZE);
  const category = normalizeNewsCategory(body && body.category);
  const version = String((body && body.version) || "").trim().slice(0, 32);
  const pinned = !!(body && body.pinned);
  const published =
    body && typeof body.published === "boolean" ? body.published : true;
  return { title, summary, body: cleanBody, category, version, pinned, published };
}

app.post("/api/admin/news", requireRole("admin"), (req, res) => {
  const p = readNewsPayload(req.body || {});
  if (!p.title) return fail(res, 400, "Title is required.");
  if (!p.summary && !p.body) {
    return fail(res, 400, "Add a summary or body.");
  }
  const id = uid("news_");
  const now = Date.now();
  db.prepare(
    `INSERT INTO news_posts
      (id, title, summary, body, category, version, created_by,
       created_at, updated_at, pinned, published)
     VALUES (@id, @title, @summary, @body, @category, @version, @createdBy,
             @createdAt, @updatedAt, @pinned, @published)`
  ).run({
    id,
    title: p.title,
    summary: p.summary,
    body: p.body,
    category: p.category,
    version: p.version,
    createdBy: req.user.username,
    createdAt: now,
    updatedAt: now,
    pinned: p.pinned ? 1 : 0,
    published: p.published ? 1 : 0,
  });
  auditLog(
    req.user.username,
    "news.create",
    id,
    { title: p.title, category: p.category, version: p.version },
    req.clientIp
  );
  const row = db.prepare(`SELECT * FROM news_posts WHERE id = ?`).get(id);
  ok(res, { post: serializeNewsRow(row) });
});

app.patch("/api/admin/news/:id", requireRole("admin"), (req, res) => {
  const existing = db
    .prepare(`SELECT id FROM news_posts WHERE id = ?`)
    .get(req.params.id);
  if (!existing) return fail(res, 404, "Not found.");
  const p = readNewsPayload(req.body || {});
  if (!p.title) return fail(res, 400, "Title is required.");
  db.prepare(
    `UPDATE news_posts
        SET title = @title,
            summary = @summary,
            body = @body,
            category = @category,
            version = @version,
            pinned = @pinned,
            published = @published,
            updated_at = @updatedAt
      WHERE id = @id`
  ).run({
    id: req.params.id,
    title: p.title,
    summary: p.summary,
    body: p.body,
    category: p.category,
    version: p.version,
    pinned: p.pinned ? 1 : 0,
    published: p.published ? 1 : 0,
    updatedAt: Date.now(),
  });
  auditLog(
    req.user.username,
    "news.update",
    req.params.id,
    { title: p.title },
    req.clientIp
  );
  const row = db
    .prepare(`SELECT * FROM news_posts WHERE id = ?`)
    .get(req.params.id);
  ok(res, { post: serializeNewsRow(row) });
});

app.delete("/api/admin/news/:id", requireRole("admin"), (req, res) => {
  const existing = db
    .prepare(`SELECT id, title FROM news_posts WHERE id = ?`)
    .get(req.params.id);
  if (!existing) return fail(res, 404, "Not found.");
  db.prepare(`DELETE FROM news_posts WHERE id = ?`).run(req.params.id);
  auditLog(
    req.user.username,
    "news.delete",
    req.params.id,
    { title: existing.title },
    req.clientIp
  );
  ok(res, {});
});

// --------------------------------------------------------------------------
// RSS feed for News
// --------------------------------------------------------------------------
//
// Public, anonymous, published-only. Served as Atom (`application/atom+xml`)
// because Atom's content model (xhtml / html / text) is cleaner than RSS 2.0
// for the sanitized HTML we already store in `news_posts.body`. Nothing here
// is rate-limited separately — it goes through the global apiLimiter like
// the JSON counterpart, so feed readers that poll aggressively degrade the
// same way as a misbehaving browser client.

function xmlEscape(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function atomFeedFromRows(rows, { siteUrl, feedPath }) {
  const updatedRow = rows[0];
  const updated = updatedRow
    ? new Date(updatedRow.updated_at || updatedRow.created_at).toISOString()
    : new Date().toISOString();

  const entries = rows
    .map((r) => {
      const url = `${siteUrl}/news.html#${encodeURIComponent(r.id)}`;
      const bodyHtml = r.body || r.summary || "";
      const published = new Date(r.created_at).toISOString();
      const rowUpdated = new Date(r.updated_at || r.created_at).toISOString();
      return `  <entry>
    <id>${xmlEscape(r.id)}</id>
    <title>${xmlEscape(r.title)}</title>
    <link rel="alternate" type="text/html" href="${xmlEscape(url)}"/>
    <updated>${rowUpdated}</updated>
    <published>${published}</published>
    <author><name>${xmlEscape(r.created_by || "Garuda Games")}</name></author>
    <category term="${xmlEscape(r.category || "general")}"/>
    <summary type="text">${xmlEscape(r.summary || "")}</summary>
    <content type="html">${xmlEscape(bodyHtml)}</content>
  </entry>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${siteUrl}${feedPath}</id>
  <title>Garuda Games — News</title>
  <subtitle>Releases, events, and announcements from garudagames.net</subtitle>
  <link rel="self" type="application/atom+xml" href="${siteUrl}${feedPath}"/>
  <link rel="alternate" type="text/html" href="${siteUrl}/news.html"/>
  <updated>${updated}</updated>
${entries}
</feed>
`;
}

app.get("/api/news.atom", apiLimiter, (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, title, summary, body, category, version, created_by,
              created_at, updated_at
         FROM news_posts
        WHERE published = 1
        ORDER BY created_at DESC
        LIMIT 50`
    )
    .all();
  const siteUrl =
    ALLOWED_ORIGINS[0] && /^https?:\/\//.test(ALLOWED_ORIGINS[0])
      ? ALLOWED_ORIGINS[0].replace(/\/$/, "")
      : "";
  const xml = atomFeedFromRows(rows, {
    siteUrl,
    feedPath: "/api/news.atom",
  });
  res.set("Content-Type", "application/atom+xml; charset=utf-8");
  res.set("Cache-Control", "public, max-age=300");
  res.send(xml);
});

// --------------------------------------------------------------------------
// Admin CSV exports (members, audit, achievements)
// --------------------------------------------------------------------------
//
// All three walk the same table the admin console already surfaces; the CSV
// variant exists so admins can pull a snapshot into a spreadsheet without
// relying on a browser "save as" of the JSON. Auth/role/audit semantics are
// identical to the JSON siblings.

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvRow(cells) {
  return cells.map(csvEscape).join(",");
}

function sendCsv(res, filename, lines) {
  // BOM so Excel opens UTF-8 CSVs correctly on Windows.
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set(
    "Content-Disposition",
    `attachment; filename="${filename}"`
  );
  res.send("\uFEFF" + lines.join("\r\n") + "\r\n");
}

app.get("/api/admin/members.csv", requireRole("admin"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT username, role, ign, real_name, squad, club_role, points,
              certified_judge, professional_blader, pro_games_json,
              created_at
         FROM users ORDER BY created_at ASC`
    )
    .all();
  const lines = [
    csvRow([
      "username", "role", "ign", "real_name", "squad", "club_role",
      "points", "certified_judge", "professional_blader", "pro_games",
      "created_at_iso",
    ]),
  ];
  for (const r of rows) {
    const proGames = readProGames(r);
    lines.push(
      csvRow([
        r.username,
        r.role,
        r.ign,
        r.real_name,
        r.squad,
        r.club_role,
        r.points,
        r.certified_judge ? "1" : "0",
        proGames.includes("Beyblade X") ? "1" : "0",
        proGames.join("|"),
        new Date(r.created_at).toISOString(),
      ])
    );
  }
  auditLog(req.user.username, "admin.export.members_csv", null, {
    count: rows.length,
  }, req.clientIp);
  sendCsv(res, "garuda-members.csv", lines);
});

app.get("/api/admin/audit.csv", requireRole("admin"), (req, res) => {
  // Same filters as the JSON endpoint, so a paginated UI view and the CSV
  // export of that view line up byte-for-byte.
  const sinceTs = parseInt(req.query.since, 10) || 0;
  const actionFilter = String(req.query.action || "").trim().toLowerCase();
  const actorFilter = String(req.query.actor || "").trim().toLowerCase();

  const where = [];
  const params = {};
  if (sinceTs > 0) {
    where.push("created_at >= @since");
    params.since = sinceTs;
  }
  if (actionFilter) {
    where.push("LOWER(action) LIKE @action");
    params.action = "%" + actionFilter + "%";
  }
  if (actorFilter) {
    where.push("LOWER(actor) LIKE @actor");
    params.actor = "%" + actorFilter + "%";
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const rows = db
    .prepare(
      `SELECT id, actor, action, target, detail_json, ip, created_at
         FROM audit_log ${whereSql} ORDER BY id DESC LIMIT 10000`
    )
    .all(params);

  const lines = [
    csvRow([
      "id", "created_at_iso", "actor", "action", "target", "ip", "detail_json",
    ]),
  ];
  for (const r of rows) {
    lines.push(
      csvRow([
        r.id,
        new Date(r.created_at).toISOString(),
        r.actor || "",
        r.action || "",
        r.target || "",
        r.ip || "",
        r.detail_json || "",
      ])
    );
  }
  auditLog(req.user.username, "admin.export.audit_csv", null, {
    count: rows.length,
  }, req.clientIp);
  sendCsv(res, "garuda-audit.csv", lines);
});

app.get("/api/admin/achievements.csv", requireRole("admin"), (req, res) => {
  const status = String(req.query.status || "").trim().toLowerCase();
  const where = [];
  const params = {};
  if (status && ["pending", "verified", "rejected"].includes(status)) {
    where.push("status = @status");
    params.status = status;
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const rows = db
    .prepare(
      `SELECT id, username, event_name, event_date, rank, rank_code, placement,
              player_count, rank_points, game, status, verifier_note,
              created_at, verified_at, verified_by
         FROM achievements ${whereSql}
         ORDER BY created_at DESC LIMIT 10000`
    )
    .all(params);
  const lines = [
    csvRow([
      "id", "username", "event_name", "event_date", "rank", "rank_code",
      "placement", "player_count", "rank_points", "game", "status",
      "verifier_note", "created_at_iso", "verified_at_iso", "verified_by",
    ]),
  ];
  for (const r of rows) {
    lines.push(
      csvRow([
        r.id, r.username, r.event_name, r.event_date || "", r.rank,
        r.rank_code || "", r.placement, r.player_count, r.rank_points,
        r.game, r.status, r.verifier_note || "",
        new Date(r.created_at).toISOString(),
        r.verified_at ? new Date(r.verified_at).toISOString() : "",
        r.verified_by || "",
      ])
    );
  }
  auditLog(req.user.username, "admin.export.achievements_csv", null, {
    count: rows.length,
  }, req.clientIp);
  sendCsv(res, "garuda-achievements.csv", lines);
});

// --------------------------------------------------------------------------
// Authenticated member search
// --------------------------------------------------------------------------
//
// Used by the Members page and any future "@-mention" surfaces. Requires
// any logged-in user (so anon scraping a full directory is harder), caps
// the page to 20 results, and lives under lookupLimiter — the 20/min window
// bounds anyone enumerating via the endpoint. Results are restricted to
// the non-sensitive profile fields already visible on /members.html.

app.get("/api/members/search", requireAuth, lookupLimiter, (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (q.length < 2) return fail(res, 400, "Query must be at least 2 chars.");
  if (q.length > 64) return fail(res, 400, "Query is too long.");
  const needle = "%" + q.replace(/[\\%_]/g, (ch) => "\\" + ch) + "%";
  const rows = db
    .prepare(
      `SELECT username, ign, squad, club_role, points,
              certified_judge, professional_blader, pro_games_json
         FROM users
        WHERE LOWER(username) LIKE @needle ESCAPE '\\'
           OR LOWER(ign)      LIKE @needle ESCAPE '\\'
           OR LOWER(squad)    LIKE @needle ESCAPE '\\'
        ORDER BY points DESC, ign COLLATE NOCASE
        LIMIT 20`
    )
    .all({ needle });
  ok(res, {
    q,
    members: rows.map((r) => {
      const proGames = readProGames(r);
      return {
        username: r.username,
        ign: r.ign,
        squad: r.squad,
        clubRole: r.club_role || "Member",
        points: r.points || 0,
        certifiedJudge: !!r.certified_judge,
        professionalBlader: proGames.includes("Beyblade X"),
        proGames,
      };
    }),
  });
});

// --------------------------------------------------------------------------
// CSP violation report sink
// --------------------------------------------------------------------------
//
// The nginx Content-Security-Policy header points `report-uri` here (see the
// nginx conf). We don't persist reports — at Garuda's traffic volume the
// useful signal is just "is anything tripping our CSP at all?", which shows
// up in the journal. Keep it size-capped so a hostile client can't flood
// the log. Returns 204 unconditionally: CSP clients ignore the body and
// the status is only for debugging.

app.post("/api/csp-report", express.json({
  limit: "32kb",
  type: ["application/csp-report", "application/json"],
}), (req, res) => {
  try {
    const report = (req.body && req.body["csp-report"]) || req.body || {};
    const violated = String(report["violated-directive"] || "").slice(0, 120);
    const blocked = String(report["blocked-uri"] || "").slice(0, 200);
    const document = String(report["document-uri"] || "").slice(0, 200);
    // eslint-disable-next-line no-console
    console.warn(
      `[csp] violated=${violated} blocked=${blocked} doc=${document}`
    );
  } catch (_) {
    // Discard malformed reports silently; the point is to not crash.
  }
  res.status(204).end();
});

// --------------------------------------------------------------------------
// Error handler
// --------------------------------------------------------------------------

app.use((err, _req, res, _next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ ok: false, error: "Server error." });
});

// Only start the listener when this file is invoked directly
// (`node index.js`). Tests import `app` via `require('./index.js')` and
// use supertest to hit routes in-process without holding a real port.
if (require.main === module) {
  app.listen(PORT, "127.0.0.1", () => {
    // eslint-disable-next-line no-console
    console.log(`garuda-api listening on 127.0.0.1:${PORT} (env=${NODE_ENV})`);
  });
}

module.exports = { app, db };
