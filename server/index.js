"use strict";

const express = require("express");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const { promisify } = require("util");
const path = require("path");
const rateLimit = require("express-rate-limit");
const sanitizeHtml = require("sanitize-html");
const qrcode = require("qrcode");
const fs = require("fs");
const { db } = require("./db");
const totp = require("./totp");
const mailer = require("./mailer");
const blobStore = require("./blob-store");
const challonge = require("./challonge");

// RFC-5322-ish email validator. Deliberately narrower than the RFC because
// real-world delivery is what matters, not theoretical validity. Max 254
// bytes per RFC-5321 §4.5.3.1. We lowercase for storage and comparison —
// SMTP local-parts are technically case-sensitive but no sane provider
// treats them as such.
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/;
function normEmail(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return "";
  if (s.length > 254) return "";
  if (!EMAIL_RE.test(s)) return "";
  return s;
}

const scryptAsync = promisify(crypto.scrypt);

const PORT = parseInt(process.env.PORT || "3000", 10);
const NODE_ENV = process.env.NODE_ENV || "production";
// "development" and "test" are both treated as non-prod: cookies allowed
// over HTTP, origin guard permissive about missing Origin/Referer, etc.
const IS_PROD = NODE_ENV !== "development" && NODE_ENV !== "test";

const COOKIE_NAME = "garuda_sid";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days (down from 30).

// v1.19.0 — 2FA enforcement on staff routes.
// Any user with role `verifier` or `admin` must have TOTP enabled before
// they can hit verifier/admin API surface. The rollout is phased with
// a grace window driven by env:
//
//   GARUDA_STAFF_2FA_GRACE_UNTIL — ISO-8601 date string (e.g.
//     "2026-05-08") or epoch-ms number. While the clock is before this
//     moment, staff without TOTP are allowed through (and the server
//     logs a `admin.2fa-grace-hit` audit row the first time each day
//     per user). After this moment, missing TOTP returns 403 with
//     `{ reason: "2fa-required" }`.
//
// Unset = enforcement is live immediately (safe default). Invalid
// value = treated as unset with a startup warning.
function parseStaff2faGrace(raw) {
  if (raw == null || raw === "") return null;
  if (/^\d+$/.test(String(raw).trim())) return Number(raw);
  const t = Date.parse(String(raw).trim());
  if (!Number.isFinite(t)) {
    console.warn(
      "[v1.19] GARUDA_STAFF_2FA_GRACE_UNTIL is not parseable: " +
        JSON.stringify(raw) +
        " — treating as unset, 2FA enforced immediately."
    );
    return null;
  }
  return t;
}
// Cached module-load value (for the startup log only). The actual
// enforcement path below calls currentStaff2faGrace() which re-reads
// the env — that lets the operator adjust the grace window with a
// service restart + env change without code edits, and gives tests a
// hook to toggle the window mid-suite.
const STAFF_2FA_GRACE_UNTIL_MS = parseStaff2faGrace(
  process.env.GARUDA_STAFF_2FA_GRACE_UNTIL
);
if (STAFF_2FA_GRACE_UNTIL_MS != null && STAFF_2FA_GRACE_UNTIL_MS > Date.now()) {
  console.log(
    "[v1.19] staff 2FA enforcement in GRACE mode until " +
      new Date(STAFF_2FA_GRACE_UNTIL_MS).toISOString()
  );
}

function currentStaff2faGrace() {
  return parseStaff2faGrace(process.env.GARUDA_STAFF_2FA_GRACE_UNTIL);
}

function isStaffRole(role) {
  return role === "verifier" || role === "admin";
}

// staffTwoFactorStatus returns the object surfaced under
// `profile.staffTwoFactor` on /api/me and the member fetchers. The UI
// uses it to show a setup banner or a blocked-state pre-gate.
function staffTwoFactorStatus(user) {
  const required = isStaffRole(user && user.role);
  const enabled = !!(user && user.totp_enabled);
  const grace = currentStaff2faGrace();
  return {
    required,
    enabled,
    graceUntil: required && !enabled ? grace : null,
    graceActive:
      required && !enabled && grace != null && grace > Date.now(),
  };
}
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

// v1.24.0 — Beyblade X tournaments must have at least this many verified
// participants to contribute ranking points. Rows below the floor stay on
// the blader's portfolio (they're real events they attended) but their
// rank_points is clamped to 0 so the leaderboard isn't inflated by casual
// 4/6/8-player meetups. Other games are unaffected and keep v1.23 scoring.
const MIN_BEYBLADE_RANKING_PARTICIPANTS = 12;

function beyxSubThreshold(game, playerCount) {
  return (
    (game || "Beyblade X") === "Beyblade X" &&
    Number(playerCount) < MIN_BEYBLADE_RANKING_PARTICIPANTS
  );
}

// v1.24.0 — the scoring engine now takes the game into account so the
// Beyblade minimum-participant rule can clamp rank_points to 0 without
// rejecting the submission. Older call sites that omit `game` fall back
// to "Beyblade X" (the legacy default in the DB) so behaviour matches
// what rows saved before v1.24 computed.
function computeAchievementPoints(rankCode, placement, playerCount, game) {
  const meta = RANK_CODES[rankCode];
  if (!meta) return 0;
  let base = meta.base;
  if (rankCode === "podium") {
    const p = parseInt(placement, 10) || 0;
    if (p < 4) return 0;
    base = 2;
  }
  if (beyxSubThreshold(game, playerCount)) return 0;
  return isGrandTournament(playerCount) ? base * 2 : base;
}

function nonScoringReason(game, playerCount) {
  if (beyxSubThreshold(game, playerCount)) {
    return (
      "Beyblade X tournaments need at least " +
      MIN_BEYBLADE_RANKING_PARTICIPANTS +
      " verified participants to count toward the leaderboard. This result still appears on the blader's portfolio."
    );
  }
  return "";
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

// Recognised Beyblade X league circuits. A PRO Beyblade X pill can only be
// claimed with evidence from one of these (PBBL = Philippine Beyblade
// Battle League, XT = Xtreme Throwdown, XV = Xtreme Vertex). See v1.14.0.
const BEYBLADE_LEAGUES = Object.freeze(["PBBL", "XT", "XV"]);
const BEYBLADE_LEAGUE_LABELS = Object.freeze({
  PBBL: "Philippine Beyblade Battle League",
  XT: "Xtreme Throwdown",
  XV: "Xtreme Vertex",
});
const MAX_EVIDENCE_NOTE = 500;
const MAX_EVIDENCE_URL = 2000;
// Social-post host allow-list used when evidence is a link rather than a
// photo. Kept deliberately short so random short-link services can't be
// used to hide the actual destination from a reviewer.
const SOCIAL_LINK_HOSTS = Object.freeze([
  "facebook.com",
  "fb.com",
  "fb.watch",
  "instagram.com",
  "tiktok.com",
  "x.com",
  "twitter.com",
  "youtube.com",
  "youtu.be",
  "threads.net",
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

// Best-effort extraction of the bare hostname for a user-supplied URL so we
// can compare against the SOCIAL_LINK_HOSTS allow-list. Returns "" if the
// string is not a parseable http/https URL.
function urlHost(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch (_) {
    return "";
  }
}

function isChallongeUrl(raw) {
  const host = urlHost(raw);
  return host === "challonge.com" || host.endsWith(".challonge.com");
}

function isSocialPostUrl(raw) {
  const host = urlHost(raw);
  if (!host) return false;
  return SOCIAL_LINK_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

// Shape-guard an entry from the client's `evidence: [...]` array on an
// /api/id-flags/request payload. Unknown games, bogus leagues, and
// over-long strings are scrubbed out silently so a malformed client
// can't DoS the verifier queue with giant images. The caller is still
// responsible for enforcing *which* games need evidence.
function sanitizeEvidenceEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const game = normalizeGame(raw.game || "");
  if (!game) return null;
  const leagueIn = String(raw.league || "").trim().toUpperCase();
  const photo = String(raw.photoDataUrl || "").slice(0, MAX_POSTER_URL);
  const link = String(raw.linkUrl || "").trim().slice(0, MAX_EVIDENCE_URL);
  const note = String(raw.note || "").trim().slice(0, MAX_EVIDENCE_NOTE);
  return {
    game,
    league:
      game === "Beyblade X" && BEYBLADE_LEAGUES.includes(leagueIn)
        ? leagueIn
        : "",
    photoDataUrl: photo,
    linkUrl: link,
    note,
  };
}

// Enforce the per-game evidence policy for a *newly-added* PRO pill. Games
// that are already on the user's profile can be re-submitted without fresh
// evidence (idempotent no-op); it's only genuinely new claims that need to
// arrive with proof. Returns an empty string on success, or a human-friendly
// reason string that maps directly to a 400 response.
function validateNewGameEvidence(game, ev) {
  if (!ev) {
    if (game === "Beyblade X") {
      return (
        "PRO Beyblade X needs evidence from a PBBL, XT, or XV event " +
        "(a Challonge bracket link or a photo from the venue)."
      );
    }
    return (
      "PRO " + game + " needs a photo OR a social-media post link " +
      "(Facebook, X/Twitter, Instagram, TikTok, or YouTube) showing you " +
      "represented the game at a recognised event."
    );
  }
  const hasPhoto = !!ev.photoDataUrl;
  const hasLink = !!ev.linkUrl;
  if (game === "Beyblade X") {
    if (!ev.league) {
      return (
        "PRO Beyblade X requires a league: PBBL (Philippine Beyblade " +
        "Battle League), XT (Xtreme Throwdown), or XV (Xtreme Vertex)."
      );
    }
    if (!hasPhoto && !hasLink) {
      return (
        "PRO Beyblade X needs a Challonge bracket link OR a photo from " +
        "the league event."
      );
    }
    if (hasLink && !hasPhoto && !isChallongeUrl(ev.linkUrl)) {
      return (
        "PRO Beyblade X bracket link must be a challonge.com URL, or " +
        "submit a photo from the event instead."
      );
    }
    return "";
  }
  if (!hasPhoto && !hasLink) {
    return (
      "PRO " + game + " needs a photo or a social-media post link."
    );
  }
  if (hasLink && !hasPhoto && !isSocialPostUrl(ev.linkUrl)) {
    return (
      "PRO " + game + " link must point to a public Facebook, X/Twitter, " +
      "Instagram, TikTok, YouTube, or Threads post — or submit a photo " +
      "instead."
    );
  }
  return "";
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

// v1.23.0 — derive the short /api/blob/<sha> URL for an image column
// that has been migrated to the blob store. Returns "" when the row
// is still legacy (no sha256), so the caller can fall back to the
// legacy inline data URL. Clients compute `imgSrc = url || dataUrl`.
function blobUrl(sha256) {
  if (!sha256 || typeof sha256 !== "string") return "";
  return "/api/blob/" + sha256;
}

// --------------------------------------------------------------------------
// v1.21.0 — Tiny in-memory TTL + ETag cache for leaderboards.
// --------------------------------------------------------------------------
//
// The `/api/leaderboard` and `/api/verifiers/leaderboard` endpoints run a
// multi-join aggregate every request. On a low-RAM VPS that's fine at
// launch and gets painful as the roster grows (N users x M achievements).
//
// Strategy:
//   * Per-endpoint-per-query-string slot, keyed on (endpoint, qs).
//   * Invalidated by a module-level `version` counter that every mutation
//     that touches leaderboard shape bumps (`bumpLeaderboardVersion()`).
//     ETag = base64(version + "/" + qshash) so a ?game=Beyblade%20X&
//     season=2026-S2 URL gets its own ETag.
//   * TTL=30s floor keeps the cache fresh even for hypothetical
//     mutations we forgot to instrument. Plenty short to feel live.
//
// Tests flip `CACHE_ENABLED` to false to exercise the direct query path.
const CACHE_TTL_MS = 30 * 1000;
let CACHE_ENABLED = process.env.GARUDA_LEADERBOARD_CACHE !== "0";
let leaderboardVersion = 1;
const leaderboardCache = new Map(); // key -> { etag, body, version, fetchedAt }

// v1.22.0 — simple cache hit/miss/304 counters, exposed via
// `GET /api/admin/cache-stats` so we can confirm the 30s TTL is
// actually saving work in production. Counters are process-local (not
// persisted) and reset whenever `resetLeaderboardStats()` is called;
// we also record a `since` marker so the admin UI can show a rate per
// unit of uptime without knowing about process restarts.
const leaderboardStats = {
  since: Date.now(),
  hits: 0,
  misses: 0,
  conditional: 0, // total If-None-Match requests seen
  notModified: 0, // subset of conditional that matched -> 304
  bypass: 0, // served with cache disabled
  versionBumps: 0,
  lastMutationAt: 0,
};

function resetLeaderboardStats() {
  leaderboardStats.since = Date.now();
  leaderboardStats.hits = 0;
  leaderboardStats.misses = 0;
  leaderboardStats.conditional = 0;
  leaderboardStats.notModified = 0;
  leaderboardStats.bypass = 0;
  leaderboardStats.versionBumps = 0;
  leaderboardStats.lastMutationAt = 0;
}

function snapshotLeaderboardStats() {
  const s = leaderboardStats;
  const total = s.hits + s.misses;
  const rate = total > 0 ? s.hits / total : 0;
  return {
    enabled: CACHE_ENABLED,
    ttlMs: CACHE_TTL_MS,
    since: s.since,
    uptimeMs: Date.now() - s.since,
    hits: s.hits,
    misses: s.misses,
    conditional: s.conditional,
    notModified: s.notModified,
    bypass: s.bypass,
    versionBumps: s.versionBumps,
    lastMutationAt: s.lastMutationAt || null,
    hitRate: Number(rate.toFixed(4)),
    slots: leaderboardCache.size,
    currentVersion: leaderboardVersion,
  };
}

function bumpLeaderboardVersion() {
  leaderboardVersion++;
  leaderboardStats.versionBumps++;
  leaderboardStats.lastMutationAt = Date.now();
  // Don't clear the Map — stale entries are harmless (ETag mismatches on
  // read) and the TTL sweep will evict them. Clearing would thrash under
  // a burst of verifier activity.
}

function leaderboardEtag(version, key) {
  // Weak ETag: quoted hash, `W/` prefix so proxies know it's semantic
  // not byte-exact (we reserialise the JSON on every serve).
  const h = crypto.createHash("sha256").update(key + ":" + version).digest("hex");
  return 'W/"lb-' + h.slice(0, 16) + '"';
}

function serveLeaderboard(req, res, cacheKey, compute) {
  if (!CACHE_ENABLED) {
    leaderboardStats.bypass++;
    res.set("Cache-Control", "no-store");
    return ok(res, compute());
  }
  const now = Date.now();
  const cached = leaderboardCache.get(cacheKey);
  const fresh =
    cached &&
    cached.version === leaderboardVersion &&
    now - cached.fetchedAt < CACHE_TTL_MS;

  let etag, body;
  if (fresh) {
    etag = cached.etag;
    body = cached.body;
    leaderboardStats.hits++;
  } else {
    body = compute();
    etag = leaderboardEtag(leaderboardVersion, cacheKey);
    leaderboardCache.set(cacheKey, {
      etag,
      body,
      version: leaderboardVersion,
      fetchedAt: now,
    });
    leaderboardStats.misses++;
    // Trim if the map grew unreasonably — we don't expect more than a
    // few dozen distinct (game, season) combos.
    if (leaderboardCache.size > 128) {
      const cutoff = now - CACHE_TTL_MS * 4;
      for (const [k, v] of leaderboardCache) {
        if (v.fetchedAt < cutoff) leaderboardCache.delete(k);
      }
    }
  }
  res.set("ETag", etag);
  res.set("Cache-Control", "public, max-age=30, must-revalidate");
  res.set("Vary", "Cookie"); // be defensive: sessions don't change the body, but proxies shouldn't assume
  const inm = req.headers["if-none-match"];
  if (inm) {
    leaderboardStats.conditional++;
    if (inm === etag) {
      leaderboardStats.notModified++;
      return res.status(304).end();
    }
  }
  return ok(res, body);
}

function __resetLeaderboardCacheForTests() {
  leaderboardVersion = 1;
  leaderboardCache.clear();
  resetLeaderboardStats();
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

// --------------------------------------------------------------------------
// TOTP recovery codes (v1.12.0)
// --------------------------------------------------------------------------
//
// Ten single-use codes are minted at 2FA verify time and displayed to
// the member exactly once. Anyone presenting a valid code at login
// instead of a current TOTP gets through, and the code is burned on
// use. See migrations/0008 for the table shape and why SHA-256 is
// fine (the code itself is 50 bits of uniform random, not a
// user-chosen password — brute force is infeasible without also
// knowing the username + password, which pass through authLimiter).

const RECOVERY_CODE_COUNT = 10;
// Crockford base32 minus I/L/O/U to keep copies off the page free of
// visually ambiguous characters. Enough entropy at 10 chars × log2(28)
// ≈ 48 bits — the upstream authLimiter (15 guesses / 10 min / IP) and
// the per-user lockout make brute force a non-starter in practice.
const RECOVERY_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const RECOVERY_CODE_LEN = 10; // 5 + 5 with a hyphen for legibility

function randInt(bound) {
  // Rejection sampling on top of crypto.randomInt — overkill for 28
  // possibilities, but avoids the modulo bias landmine.
  return crypto.randomInt(bound);
}

function generateRecoveryCodePlain() {
  let raw = "";
  for (let i = 0; i < RECOVERY_CODE_LEN; i++) {
    raw += RECOVERY_CODE_ALPHABET[randInt(RECOVERY_CODE_ALPHABET.length)];
  }
  // Display format: two 5-char groups for readability. Normalisation
  // on redemption strips non-alphanumerics so members can paste it
  // back in with or without the hyphen.
  return raw.slice(0, 5) + "-" + raw.slice(5);
}

function normalizeRecoveryCode(candidate) {
  return String(candidate || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function hashRecoveryCode(plain) {
  // The codes are public-server generated + never user-chosen, so the
  // input space is the whole 28^10 alphabet. SHA-256 is plenty; there
  // is nothing a KDF would meaningfully defend against here.
  return crypto
    .createHash("sha256")
    .update(normalizeRecoveryCode(plain))
    .digest("hex");
}

/**
 * Replace every recovery code for `username` with a fresh set of
 * RECOVERY_CODE_COUNT. Returns the plaintext codes in display format
 * — the ONLY moment they ever exist off-disk. Callers MUST surface
 * them to the user immediately; we never store them in cleartext and
 * we never mint them again for the same codes.
 */
function issueRecoveryCodes(username) {
  const codes = [];
  const rows = [];
  const now = Date.now();
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const plain = generateRecoveryCodePlain();
    codes.push(plain);
    rows.push({
      id: uid("rc_"),
      username: String(username).toLowerCase(),
      code_hash: hashRecoveryCode(plain),
      issued_at: now,
    });
  }
  const tx = db.transaction(() => {
    // Wipe every prior code — both used and unused — so the "X left"
    // counter matches what we just issued and an old burned code
    // can't accidentally be re-minted by a collision.
    db.prepare(
      `DELETE FROM totp_recovery_codes WHERE username = ?`
    ).run(String(username).toLowerCase());
    const ins = db.prepare(
      `INSERT INTO totp_recovery_codes
         (id, username, code_hash, issued_at, used_at)
       VALUES (@id, @username, @code_hash, @issued_at, NULL)`
    );
    for (const r of rows) ins.run(r);
  });
  tx();
  return codes;
}

function countRecoveryCodes(username) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM totp_recovery_codes
        WHERE username = ? AND used_at IS NULL`
    )
    .get(String(username).toLowerCase());
  return row ? row.n : 0;
}

function clearRecoveryCodes(username) {
  db.prepare(
    `DELETE FROM totp_recovery_codes WHERE username = ?`
  ).run(String(username).toLowerCase());
}

/**
 * Attempt to burn a recovery code for `username`. Returns true on
 * success (code existed, was unused, and is now marked used_at = now),
 * false otherwise. The DB index on (username, code_hash) WHERE
 * used_at IS NULL keeps this O(log n) even with history retained.
 */
function redeemRecoveryCode(username, candidate) {
  const plain = normalizeRecoveryCode(candidate);
  if (!plain || plain.length !== RECOVERY_CODE_LEN) return false;
  const hash = hashRecoveryCode(plain);
  const row = db
    .prepare(
      `SELECT id FROM totp_recovery_codes
        WHERE username = ? AND code_hash = ? AND used_at IS NULL
        LIMIT 1`
    )
    .get(String(username).toLowerCase(), hash);
  if (!row) return false;
  const info = db
    .prepare(
      `UPDATE totp_recovery_codes SET used_at = ?
        WHERE id = ? AND used_at IS NULL`
    )
    .run(Date.now(), row.id);
  // If the UPDATE didn't actually flip a row (e.g. two simultaneous
  // requests raced), the other request won — reject this one rather
  // than let a single code authenticate twice.
  return info.changes === 1;
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
    photoUrl: blobUrl(row.photo_sha256 || ""),
    photoDataUrl: row.photo_data_url || "",
    certifiedJudge: !!row.certified_judge,
    professionalBlader: proGames.includes("Beyblade X"),
    proGames,
    points: row.points || 0,
    createdAt: row.created_at,
    totpEnabled: !!row.totp_enabled,
    email: row.email || "",
    hasEmail: !!(row.email && String(row.email).trim()),
    emailVerifiedAt: row.email_verified_at || null,
    emailVerified: !!row.email_verified_at,
    // v1.19.0 — surfaces staff-2FA state so the dashboard + admin /
    // verifier pages can render the setup banner (grace window) or the
    // blocked-state pre-gate (post-grace). For non-staff users this
    // reads `{ required: false, enabled, graceUntil: null }`.
    staffTwoFactor: staffTwoFactorStatus(row),
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
    photoUrl: blobUrl(row.photo_sha256 || ""),
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

// v1.25.0 — fan a single "new work in your queue" ping out to every
// verifier + admin. Dedup so an already-unread notification of the
// same kind is NOT replaced: the staff member hasn't acked the queue
// yet, firing a second row would just be spam. Once the staff member
// reads (or clears) the row, the next submission produces a fresh
// unread notification and the cycle continues. `excludeUsername` lets
// a trigger skip the acting user when they also hold a staff role
// (they're the one who just created the row — no need to notify
// themselves).
function notifyStaff(
  kind,
  title,
  body,
  link,
  { excludeUsername = "" } = {}
) {
  try {
    const staff = db
      .prepare(
        `SELECT username FROM users
          WHERE LOWER(role) IN ('verifier', 'admin')`
      )
      .all();
    if (!staff.length) return 0;
    const skip = String(excludeUsername || "").toLowerCase();
    const findUnread = db.prepare(
      `SELECT id FROM notifications
        WHERE username = ? AND kind = ? AND read_at IS NULL
        LIMIT 1`
    );
    const ins = db.prepare(
      `INSERT INTO notifications (id, username, kind, title, body, link, created_at)
       VALUES (@id, @username, @kind, @title, @body, @link, @created_at)`
    );
    const kindClean = String(kind || "queue").slice(0, 32);
    const titleClean = String(title || "").slice(0, 160);
    const bodyClean = String(body || "").slice(0, 512);
    const linkClean = String(link || "").slice(0, 256);
    const now = Date.now();
    let created = 0;
    const tx = db.transaction(() => {
      for (const s of staff) {
        const uname = String(s.username).toLowerCase();
        if (uname === skip) continue;
        if (findUnread.get(uname, kindClean)) continue;
        ins.run({
          id: uid("ntf_"),
          username: uname,
          kind: kindClean,
          title: titleClean,
          body: bodyClean,
          link: linkClean,
          created_at: now,
        });
        created++;
      }
    });
    tx();
    return created;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("notifyStaff failed:", e.message);
    return 0;
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

// Keep session metadata compact. Browsers emit 200+ char UA strings
// already; pushing the cap higher just bloats the table without adding
// information our UI can render.
const MAX_UA_LEN = 255;
// Debounce last_seen_at bumps so every single XHR doesn't issue a DB
// write. Sixty seconds is a good tradeoff — the sessions UI is
// accurate-to-a-minute, which is more than precise enough to spot an
// unknown session you want to kill.
const LAST_SEEN_DEBOUNCE_MS = 60 * 1000;

function createSession(username, { userAgent = "", ipAddress = "" } = {}) {
  const sid = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions
       (id, username, created_at, expires_at, user_agent, ip_address, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sid,
    username,
    now,
    now + SESSION_TTL_MS,
    String(userAgent || "").slice(0, MAX_UA_LEN),
    String(ipAddress || ""),
    now
  );
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

// Non-failing sibling of requireAuth. Populates req.user / req.session
// when the caller has a valid session cookie, otherwise leaves them
// undefined. Used by endpoints (/api/blob/:sha256) that serve some
// public content but upgrade to richer content when the caller is
// signed in.
function maybeAttachUser(req) {
  if (req.user) return;
  const sid = req.cookies && req.cookies[COOKIE_NAME];
  if (!sid) return;
  const s = getSession(sid);
  if (!s) return;
  const user = getUserByUsername(s.username);
  if (!user) return;
  req.session = s;
  req.user = user;
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
  // Debounced write of last_seen_at. Avoids a DB write on every XHR —
  // the sessions UI only needs minute-level precision. Done in-line
  // (synchronous, same transaction boundary as the authentication
  // check) because better-sqlite3 is synchronous anyway; moving it to
  // setImmediate would just complicate test determinism.
  const now = Date.now();
  if (!s.last_seen_at || now - s.last_seen_at >= LAST_SEEN_DEBOUNCE_MS) {
    db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).run(
      now,
      s.id
    );
    s.last_seen_at = now;
  }
  next();
}

function requireRole(minRole) {
  const order = { user: 0, verifier: 1, admin: 2 };
  const minRank = order[minRole] || 0;
  const gateIsStaff = minRank >= order.verifier;
  return (req, res, next) => {
    requireAuth(req, res, (err) => {
      if (err) return next(err);
      if ((order[req.user.role] || 0) < minRank) {
        return fail(res, 403, "Forbidden.");
      }
      // v1.19.0 — block staff without TOTP once the grace window is
      // over. A separate path logs a lower-severity grace-hit so we can
      // see on the audit log exactly who's still operating without 2FA
      // during the rollout window, but doesn't stop them from working.
      if (gateIsStaff && isStaffRole(req.user.role) && !req.user.totp_enabled) {
        const now = Date.now();
        const graceUntil = currentStaff2faGrace();
        const graceActive = graceUntil != null && graceUntil > now;
        if (!graceActive) {
          auditLog(
            req.user.username,
            "admin.2fa-denied",
            req.user.username,
            { role: req.user.role, path: req.originalUrl },
            req.clientIp
          );
          return res.status(403).json({
            ok: false,
            error:
              "Two-factor authentication is required for " +
              req.user.role +
              " accounts. Open the Dashboard and enable TOTP under Account -> Two-factor authentication before using " +
              "staff tools.",
            reason: "2fa-required",
            graceUntil,
          });
        }
        // Grace still active — log once per day per user to avoid
        // filling the audit log with one row per API call. A simple
        // dedup keyed on target + action + YYYY-MM-DD.
        const today = new Date(now).toISOString().slice(0, 10);
        const existing = db
          .prepare(
            `SELECT id FROM audit_log
              WHERE target = ?
                AND action = 'admin.2fa-grace-hit'
                AND detail_json LIKE ?
              LIMIT 1`
          )
          .get(req.user.username, '%"day":"' + today + '"%');
        if (!existing) {
          auditLog(
            req.user.username,
            "admin.2fa-grace-hit",
            req.user.username,
            {
              role: req.user.role,
              day: today,
              graceUntil,
            },
            req.clientIp
          );
        }
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

// Dedicated cap for data export. The payload can be large and assembling
// it hits several tables; a well-intentioned user only needs it once or
// twice a year, a misbehaving script hammering it 1000/hour is almost
// certainly trying to scrape. Capped per IP and — since this is a
// cookie-gated route — effectively per session too.
const exportLimiter = SKIP_RATE_LIMIT
  ? passthrough
  : rateLimit({
      windowMs: 60 * 60 * 1000,
      limit: 10,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: {
        ok: false,
        error:
          "You've requested your data export too many times in the last hour. Try again later.",
      },
    });

// v1.13.0: tight cap on DELETE /api/me/sessions/:id. A legitimate
// user clicks "Revoke" once, maybe a handful of times if they ran
// five tabs logged in and want to tidy up. A scripted attacker who
// got hold of a cookie and wants to brute-force session IDs or
// walk every UUID in the table will hit this quickly. 30 per hour
// per IP is still comfortably more than anyone should ever need
// and catches automation long before it does meaningful damage.
// v1.26.0: outbound Challonge fetches happen on a dedicated cap so a
// user spamming the preview button can't push us past Challonge's
// anonymous rate limit. 30 previews / 10 min / IP is well above what
// any human posting real tournaments would need; combined with the
// 24-hour cache it means repeated pastes of the same URL never leave
// our box.
const challongePreviewLimiter = SKIP_RATE_LIMIT
  ? passthrough
  : rateLimit({
      windowMs: 10 * 60 * 1000,
      limit: 30,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: {
        ok: false,
        error:
          "Too many Challonge previews — slow down, or fill the form in manually.",
      },
    });

const sessionRevokeLimiter = SKIP_RATE_LIMIT
  ? passthrough
  : rateLimit({
      windowMs: 60 * 60 * 1000,
      limit: 30,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: {
        ok: false,
        error:
          "Too many session revoke attempts. Try again in a few minutes.",
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
  // Email is optional. An invalid one is rejected rather than silently
  // discarded — otherwise users who typo their address silently lose
  // access to the self-service reset path.
  let email = "";
  if (body.email != null && String(body.email).trim() !== "") {
    email = normEmail(body.email);
    if (!email) {
      return fail(res, 400, "That email address doesn't look valid.");
    }
  }
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
      photo_data_url, certified_judge, professional_blader, points, created_at,
      email
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, 0, 0, ?, ?)`
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
    now,
    email
  );

  auditLog("system", "user.register", username, {}, req.clientIp);

  // Fire the "please confirm this address" mail on registration. The
  // account is usable before confirmation — only the self-service
  // password reset path requires a verified email. See Phase 8
  // (v1.8.0) in the changelog.
  if (email) {
    issueEmailVerification(username, email, "system", req.clientIp);
  }

  ok(res, {
    username,
    role,
    isFirst: false,
    emailPending: !!email,
  });
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
    // Two accepted shapes:
    //   - 6-digit TOTP code (preferred path)
    //   - recovery code (emergency path; minted at 2FA verify, single
    //     use, burned on redemption). A correctly-formed TOTP (6
    //     digits) never collides with a recovery code (10
    //     alphanumerics after normalisation), so we can route by shape.
    const trimmed = String(totpCode).trim();
    const compact = normalizeRecoveryCode(trimmed);
    const isTotpShape = /^\d{6}$/.test(trimmed);
    let good2fa = false;
    let via = null;
    if (isTotpShape) {
      good2fa =
        user.totp_secret && totp.verify(user.totp_secret, trimmed);
      via = "totp";
    } else if (compact.length === RECOVERY_CODE_LEN) {
      good2fa = redeemRecoveryCode(user.username, trimmed);
      via = "recovery";
    }
    if (!good2fa) {
      recordLoginAttempt(lockKey, false);
      auditLog(username, "auth.login.totp_fail", null, {}, req.clientIp);
      return fail(res, 401, "Invalid username or password.");
    }
    if (via === "recovery") {
      // Burning a recovery code is a security-relevant event. Log it
      // immediately and drop a security notification into the inbox
      // so a real owner notices when they didn't authorise it.
      auditLog(
        user.username,
        "2fa.recovery.used",
        null,
        { remaining: countRecoveryCodes(user.username) },
        req.clientIp
      );
      notifyAccountChange(
        user.username,
        "2fa.recovery.used",
        req,
        `${countRecoveryCodes(user.username)} recovery code${
          countRecoveryCodes(user.username) === 1 ? "" : "s"
        } remaining.`
      );
    }
  }

  recordLoginAttempt(lockKey, true);
  const sid = createSession(user.username, {
    userAgent: req.get("user-agent") || "",
    ipAddress: req.clientIp || "",
  });
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
  notifyAccountChange(req.user.username, "2fa.enable", req);
  // v1.12.0: mint the initial recovery-code batch exactly once here.
  // These are the ONLY time we return plaintext codes from the API;
  // the dashboard is responsible for showing them to the member and
  // nudging them to save the file. If they lose them, /regenerate
  // mints a fresh set.
  const codes = issueRecoveryCodes(req.user.username);
  ok(res, { enabled: true, recoveryCodes: codes });
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
  clearRecoveryCodes(req.user.username);
  auditLog(req.user.username, "2fa.disabled", null, {}, req.clientIp);
  notifyAccountChange(req.user.username, "2fa.disable", req);
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
    clearRecoveryCodes(target);
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
// TOTP recovery codes (v1.12.0)
// --------------------------------------------------------------------------
//
// The dashboard shows a small "Recovery codes: N remaining" badge
// whenever 2FA is enabled; that count lives here. Regenerate mints a
// fresh batch of ten and returns the new plaintext list exactly once
// — this is the only API shape where plaintext codes ever leave the
// server.
//
// Regeneration is a sensitive action (it invalidates every previously-
// printed code, so an attacker who stole the last printout could use
// it to lock the owner out of their own backup). We therefore require
// the member's current password AND a fresh TOTP code — same bar as
// /api/me/2fa/disable, scaled up with the password check.

app.get("/api/me/2fa/recovery-codes/status", requireAuth, (req, res) => {
  const row = db
    .prepare("SELECT totp_enabled FROM users WHERE username = ?")
    .get(req.user.username);
  if (!row || !row.totp_enabled) {
    return ok(res, { enabled: false, remaining: 0 });
  }
  ok(res, {
    enabled: true,
    remaining: countRecoveryCodes(req.user.username),
    total: RECOVERY_CODE_COUNT,
  });
});

app.post(
  "/api/me/2fa/recovery-codes/regenerate",
  requireAuth,
  async (req, res) => {
    const body = req.body || {};
    const password = String(body.password || "");
    const totpCode = String(body.code || "").trim();

    const row = db
      .prepare(
        `SELECT totp_secret, totp_enabled, password_hash, password_salt,
                password_kdf
           FROM users WHERE username = ?`
      )
      .get(req.user.username);
    if (!row || !row.totp_enabled) {
      return fail(
        res,
        400,
        "Two-factor authentication isn't enabled on this account."
      );
    }
    let good = false;
    try {
      good = await verifyPassword(
        password,
        row.password_salt,
        row.password_hash,
        row.password_kdf
      );
    } catch (_) {
      good = false;
    }
    if (!good) {
      auditLog(
        req.user.username,
        "2fa.recovery.regen.fail",
        null,
        { reason: "bad_password" },
        req.clientIp
      );
      return fail(res, 401, "Password is incorrect.");
    }
    if (!totp.verify(row.totp_secret, totpCode)) {
      auditLog(
        req.user.username,
        "2fa.recovery.regen.fail",
        null,
        { reason: "bad_totp" },
        req.clientIp
      );
      return fail(res, 401, "That authenticator code didn't match.");
    }
    const codes = issueRecoveryCodes(req.user.username);
    auditLog(
      req.user.username,
      "2fa.recovery.regenerated",
      null,
      { count: codes.length },
      req.clientIp
    );
    notifyAccountChange(req.user.username, "2fa.recovery.regenerated", req);
    ok(res, { recoveryCodes: codes });
  }
);

// --------------------------------------------------------------------------
// Active sessions list + revoke (v1.9.0)
// --------------------------------------------------------------------------
//
// Gives the member a window into every cookie we're still honouring
// for their account: when it was minted, when we last saw it, which
// IP and (very short) browser fingerprint came with it. They can
// revoke any individual session, or revoke everything except the
// current one ("nuke all other devices"). A revoke-all also fires a
// security notification to the verified email on file.

// Condense a raw UA string into a human-friendly 1-token label. This
// is shown to members, not used for security decisions. If the
// fingerprint gets it wrong the worst case is "the UI calls Chrome
// a Browser" — nothing breaks.
function friendlyUserAgent(ua) {
  const s = String(ua || "");
  if (!s) return "Unknown browser";
  if (/\bEdg\//.test(s)) return "Edge";
  if (/\bOPR\//.test(s) || /\bOpera\//.test(s)) return "Opera";
  if (/\bFirefox\//.test(s)) return "Firefox";
  if (/\bCriOS\//.test(s)) return "Chrome (iOS)";
  if (/\bChrome\//.test(s)) return "Chrome";
  if (/\bSafari\//.test(s)) return "Safari";
  if (/curl|wget|Postman|python|Go-http/i.test(s)) return "API client";
  return "Browser";
}

function friendlyPlatform(ua) {
  const s = String(ua || "");
  if (/Windows/.test(s)) return "Windows";
  if (/Macintosh|Mac OS X/.test(s)) return "macOS";
  if (/iPhone|iPad|iPod/.test(s)) return "iOS";
  if (/Android/.test(s)) return "Android";
  if (/Linux/.test(s)) return "Linux";
  return "";
}

// Hide the tail of an IP when rendering back to the user. Not
// strictly a privacy requirement — members are looking at their own
// sessions — but screenshots leak, and the coarse prefix is all you
// need to tell sessions apart ("both on 203.0.113.x" vs "one on
// some other ISP").
function maskIp(ip) {
  const s = String(ip || "");
  if (!s) return "";
  if (s.includes(".")) {
    const parts = s.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
  }
  if (s.includes(":")) {
    const parts = s.split(":").filter(Boolean);
    return parts.slice(0, 3).join(":") + ":…";
  }
  return s;
}

// v1.13.0: best-effort, offline-only IP-to-location lookup for the
// "Active sessions" card. Uses fast-geoip (MIT) which lazy-loads its
// MaxMind-derived DB chunks from disk — no network calls, no
// per-request cost after the first hit in each region.
//
// Returns a human-readable "City, COUNTRY" / "COUNTRY" / "" string
// suitable for dropping into UI text. We deliberately do not expose
// lat/lon or ISP — the point is to help a member spot "why is there
// a session from Vietnam" at a glance, not to build a tracking
// profile of the member against their own account.
//
// fast-geoip's `lookup()` is async; the helper swallows every error
// path (including loopback/private addresses that naturally return
// null) so a failing lookup never takes down the sessions endpoint.
let _geoip = null;
function loadGeoip() {
  if (_geoip !== null) return _geoip;
  try {
    _geoip = require("fast-geoip");
  } catch (_) {
    _geoip = false;
  }
  return _geoip;
}

async function friendlyLocation(ip) {
  const s = String(ip || "").trim();
  if (!s) return "";
  // Fast-path loopback and RFC1918 ranges — no geolocation ever
  // resolves them and we don't want to waste DB lookups on localhost.
  if (
    s === "::1" ||
    s === "127.0.0.1" ||
    s.startsWith("10.") ||
    s.startsWith("192.168.") ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(s) ||
    s.startsWith("fe80:")
  ) {
    return "Local network";
  }
  const geoip = loadGeoip();
  if (!geoip || !geoip.lookup) return "";
  try {
    const hit = await geoip.lookup(s);
    if (!hit) return "";
    const city = hit.city || "";
    const country = hit.country || "";
    if (city && country) return `${city}, ${country}`;
    return country || "";
  } catch (_) {
    return "";
  }
}

app.get("/api/me/sessions", requireAuth, async (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, created_at, expires_at, user_agent, ip_address, last_seen_at
         FROM sessions
        WHERE username = ?
        ORDER BY COALESCE(last_seen_at, created_at) DESC`
    )
    .all(req.user.username);
  const currentId = req.session && req.session.id;
  // Run every IP->location lookup in parallel. The DB backing
  // fast-geoip is memory-mapped after the first hit, so N parallel
  // lookups for nearby IPs cost about the same as one.
  const locations = await Promise.all(
    rows.map((row) =>
      friendlyLocation(row.ip_address).catch(() => "")
    )
  );
  const shaped = rows.map((row, i) => ({
    id: row.id,
    // Short prefix is plenty for the UI to key off of — no reason to
    // echo the whole secret even to the owner.
    idShort: row.id.slice(0, 8),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    browser: friendlyUserAgent(row.user_agent),
    platform: friendlyPlatform(row.user_agent),
    userAgent: String(row.user_agent || "").slice(0, 255),
    ip: maskIp(row.ip_address),
    location: locations[i] || "",
    isCurrent: row.id === currentId,
  }));
  ok(res, { sessions: shaped, currentId: currentId || null });
});

app.delete("/api/me/sessions/:id", sessionRevokeLimiter, requireAuth, (req, res) => {
  const target = String(req.params.id || "");
  if (!target) return fail(res, 400, "Missing session id.");
  const row = db
    .prepare(`SELECT id, username FROM sessions WHERE id = ?`)
    .get(target);
  if (!row || row.username !== req.user.username) {
    // Don't tell the caller whether the session exists but belongs to
    // somebody else — return the same generic 404 either way.
    return fail(res, 404, "Session not found.");
  }
  const isCurrent = req.session && req.session.id === target;
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(target);
  auditLog(
    req.user.username,
    "session.revoke",
    null,
    { targetId: target.slice(0, 8), self: isCurrent },
    req.clientIp
  );
  if (isCurrent) clearCookie(res);
  // Only mirror non-self revokes into the inbox — self-revoke kicks
  // the cookie out from under the user, so there's nobody to read it.
  if (!isCurrent) {
    notifyAccountChange(
      req.user.username,
      "session.revoke",
      req,
      `Session ${target.slice(0, 8)}… was signed out.`
    );
  }
  ok(res, { revoked: true, isCurrent });
});

// --------------------------------------------------------------------------
// Data rights: self-service export + account deletion (v1.10.0)
// --------------------------------------------------------------------------

// Build a single JSON document with everything we store about the
// caller. Intentionally excludes password material (hash/salt/kdf),
// the raw TOTP secret, and session ids beyond their short prefix.
// The goal is "what we know about you", not "credentials a stranger
// could reuse if this file leaks from your Downloads folder".
function buildExport(username) {
  const u = getUserByUsername(username);
  if (!u) return null;
  const strip = (row) => {
    const copy = { ...row };
    delete copy.password_hash;
    delete copy.password_salt;
    delete copy.password_kdf;
    delete copy.totp_secret;
    return copy;
  };
  const sessions = db
    .prepare(
      `SELECT id, created_at, expires_at, last_seen_at, user_agent, ip_address
         FROM sessions WHERE username = ?
        ORDER BY created_at DESC`
    )
    .all(username)
    .map((s) => ({
      idShort: s.id.slice(0, 8),
      createdAt: s.created_at,
      expiresAt: s.expires_at,
      lastSeenAt: s.last_seen_at,
      userAgent: s.user_agent,
      ipAddress: s.ip_address,
    }));
  const achievements = db
    .prepare(
      `SELECT * FROM achievements WHERE username = ? ORDER BY created_at DESC`
    )
    .all(username);
  const jlap = db
    .prepare(
      `SELECT * FROM jlap_submissions WHERE username = ? ORDER BY created_at DESC`
    )
    .all(username);
  const idFlags = db
    .prepare(
      `SELECT * FROM id_flag_requests WHERE username = ? ORDER BY created_at DESC`
    )
    .all(username);
  const notifications = db
    .prepare(
      `SELECT * FROM notifications WHERE username = ? ORDER BY created_at DESC`
    )
    .all(username);
  const audit = db
    .prepare(
      `SELECT id, actor, action, target, detail_json, ip, created_at
         FROM audit_log
        WHERE actor = ? OR target = ?
        ORDER BY created_at DESC
        LIMIT 1000`
    )
    .all(username, username);
  return {
    schema: "garudagames.account-export.v1",
    generatedAt: Date.now(),
    profile: strip(u),
    sessions,
    achievements,
    jlapSubmissions: jlap,
    idFlagRequests: idFlags,
    notifications,
    auditTrail: audit,
  };
}

app.get("/api/me/export", exportLimiter, requireAuth, (req, res) => {
  const data = buildExport(req.user.username);
  if (!data) return fail(res, 500, "Could not assemble export.");
  auditLog(req.user.username, "me.export", null, {}, req.clientIp);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="garudagames-${req.user.username}-${Date.now()}.json"`
  );
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify(data, null, 2));
});

// Self-service account deletion. Destructive, so we require:
//   - current password re-entered (this is not the "you're already
//     signed in" shortcut — the 5-minute attacker sitting at your
//     laptop shouldn't be able to nuke the account; the real owner
//     typing their password should),
//   - a valid TOTP code if 2FA is enabled,
//   - an explicit confirmation string matching the username so the
//     backend rejects accidental fetches.
//
// Admins are allowed to self-delete, but only if at least one other
// admin remains — otherwise the club would be locked out of its own
// admin panel with no recovery path short of a DB surgery.
app.post("/api/me/delete", authLimiter, requireAuth, async (req, res) => {
  const body = req.body || {};
  const password = String(body.password || "");
  const confirm = String(body.confirm || "").trim();
  const totpCode = String(body.totpCode || "").trim();

  if (confirm !== req.user.username) {
    return fail(
      res,
      400,
      `Type your username ("${req.user.username}") in the confirmation box to proceed.`
    );
  }
  let good = false;
  try {
    good = await verifyPassword(
      password,
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
      "me.delete.fail",
      null,
      { reason: "bad_password" },
      req.clientIp
    );
    return fail(res, 401, "Password is incorrect.");
  }
  if (req.user.totp_enabled) {
    if (!totp.verify(req.user.totp_secret || "", totpCode)) {
      auditLog(
        req.user.username,
        "me.delete.fail",
        null,
        { reason: "bad_totp" },
        req.clientIp
      );
      return fail(res, 401, "Invalid two-factor code.");
    }
  }
  if (req.user.role === "admin") {
    const remaining = db
      .prepare(
        `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND username != ?`
      )
      .get(req.user.username);
    if (!remaining || remaining.n < 1) {
      return fail(
        res,
        400,
        "You're the last admin. Promote another member to admin before deleting your account."
      );
    }
  }

  const username = req.user.username;
  const hadVerifiedEmail = !!(req.user.email && req.user.email_verified_at);
  const oldEmail = req.user.email || "";

  // Tear down in a single transaction. The CASCADEs on sessions,
  // achievements, jlap_submissions, id_flag_requests, and
  // notifications do the heavy lifting; the explicit DELETEs below
  // clean up tables that lack a FK back to users.
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM password_reset_tokens WHERE username = ?`
    ).run(username);
    db.prepare(
      `DELETE FROM email_verification_tokens WHERE username = ?`
    ).run(username);
    // Anonymise authored news posts rather than deleting them — the
    // public feed shouldn't lose history because an author left.
    db.prepare(
      `UPDATE news_posts SET created_by = 'deleted_user' WHERE created_by = ?`
    ).run(username);
    // Anonymise audit trail rows. We keep the timeline (important for
    // moderation reviews) but we're not holding the username as a
    // personal identifier in perpetuity.
    db.prepare(
      `UPDATE audit_log SET actor = 'deleted_user' WHERE actor = ?`
    ).run(username);
    db.prepare(
      `UPDATE audit_log SET target = 'deleted_user' WHERE target = ?`
    ).run(username);
    db.prepare(`DELETE FROM users WHERE username = ?`).run(username);
  });
  tx();

  clearCookie(res);
  auditLog("deleted_user", "me.delete.ok", null, { from: "self" }, req.clientIp);

  // Belt-and-braces: fire a final "your account was deleted" notice
  // to the address on file, if we had one proven, so a hijacker who
  // made it this far still can't do it silently.
  if (hadVerifiedEmail) {
    mailer
      .sendSecurityNotification({
        to: oldEmail,
        username,
        event: "password.change", // event label is close enough; body is explicit
        detail: "The Garuda Games account tied to this email was deleted.",
        ip: req.clientIp,
        when: Date.now(),
      })
      .catch(() => {});
  }
  ok(res, { deleted: true });
});

app.post("/api/me/sessions/revoke-all", requireAuth, (req, res) => {
  const currentId = req.session && req.session.id;
  const info = db
    .prepare(
      `DELETE FROM sessions WHERE username = ? AND id != ?`
    )
    .run(req.user.username, currentId || "");
  auditLog(
    req.user.username,
    "session.revoke_all",
    null,
    { deleted: info.changes },
    req.clientIp
  );
  if (info.changes > 0) {
    notifyAccountChange(
      req.user.username,
      "sessions.revoke_all",
      req,
      `${info.changes} session${info.changes === 1 ? "" : "s"} ended`
    );
  }
  ok(res, { revoked: info.changes });
});

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
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

// v1.11.0: labels for the in-app inbox copy of a security event. We
// keep these in lockstep with the mailer's `friendly` map so that
// whether the member sees it on-screen or in Gmail, the wording is
// identical.
const SECURITY_EVENT_LABELS = {
  "password.change": "Your password was changed",
  "password.reset": "Your password was reset",
  "2fa.enable": "Two-factor authentication turned on",
  "2fa.disable": "Two-factor authentication turned off",
  "2fa.recovery.used": "A 2FA recovery code was used to sign in",
  "2fa.recovery.regenerated": "Your 2FA recovery codes were regenerated",
  "email.change": "Your account email was changed",
  "sessions.revoke_all": "All other sessions were signed out",
  "session.revoke": "A session was revoked",
};

/**
 * Fire-and-forget "something changed on your account" notification.
 *
 * Always writes an in-app inbox row (v1.11.0) so the member sees the
 * event whether or not SMTP is configured or their email is verified.
 * The email is only sent when the recipient has a verified address on
 * file — the v1.8.0 footgun (attacker sets a victim's address then
 * spams them with security notices) remains closed.
 */
function notifyAccountChange(username, event, req, detail = null) {
  const title =
    SECURITY_EVENT_LABELS[event] || `Security event: ${event}`;
  const body = [
    detail ? String(detail) : "",
    req && req.clientIp ? `Source IP (approximate): ${req.clientIp}` : "",
    "If this wasn't you, change your password and review your active sessions.",
  ]
    .filter(Boolean)
    .join(" ");
  // Inbox copy — best-effort, never blocks the auth operation.
  try {
    notify(username, "security", title, body, "dashboard.html#sessions-card");
  } catch (_err) {
    /* swallow */
  }

  try {
    const u = getUserByUsername(username);
    if (!u || !u.email || !u.email_verified_at) return;
    mailer
      .sendSecurityNotification({
        to: u.email,
        username: u.username,
        event,
        detail: detail ? String(detail) : "",
        ip: req && req.clientIp,
        when: Date.now(),
      })
      .catch(() => {});
  } catch (_err) {
    // Never let a notification failure break the primary auth operation.
  }
}

function generateResetToken() {
  return crypto.randomBytes(32).toString("base64url");
}

// Shared with the reset token generator — same cryptographic strength,
// separate function name so the intent at each call site is obvious.
function generateVerificationToken() {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Issue a fresh email verification token for `username` <`email`>.
 * Invalidates any previously-unused token for the same user in the
 * same transaction. Fires the mailer fire-and-forget so a slow SMTP
 * relay can't be used to probe account state via response timing.
 * Audit log is written regardless of SMTP outcome.
 */
function issueEmailVerification(username, email, actor, clientIp) {
  const now = Date.now();
  const token = generateVerificationToken();
  const expiresAt = now + EMAIL_VERIFY_TTL_MS;
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE email_verification_tokens
          SET used_at = ?
        WHERE username = ? AND used_at IS NULL`
    ).run(now, username);
    db.prepare(
      `INSERT INTO email_verification_tokens
          (token, username, email, issued_at, expires_at)
        VALUES (?, ?, ?, ?, ?)`
    ).run(token, username, email, now, expiresAt);
  });
  tx();
  mailer
    .sendVerificationEmail({ to: email, username, token, expiresAt })
    .then((result) => {
      auditLog(
        actor || username,
        "auth.email_verification.issue",
        username,
        { via: result.via, sent: !!result.sent, email },
        clientIp
      );
    })
    .catch((err) => {
      auditLog(
        actor || username,
        "auth.email_verification.issue",
        username,
        { via: "smtp", sent: false, error: String(err && err.message) },
        clientIp
      );
    });
  return { token, expiresAt };
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
      { expiresAt, email: !!existing.email },
      req.clientIp
    );

    // If the target member has an email on file, also send the link.
    // We do NOT wait for the mailer — the admin still gets the token
    // immediately (the copy-paste fallback is canonical) and the email
    // is best-effort.
    let emailAttempted = false;
    if (existing.email) {
      emailAttempted = true;
      mailer
        .sendResetEmail({
          to: existing.email,
          username: target,
          token,
          issuedBy: req.user.username,
          expiresAt,
        })
        .then((result) => {
          auditLog(
            req.user.username,
            "admin.password_reset.email",
            target,
            { via: result.via, sent: !!result.sent },
            req.clientIp
          );
        })
        .catch(() => {
          /* already audited by mailer branch */
        });
    }

    ok(res, {
      token,
      expiresAt,
      expiresInMs: RESET_TOKEN_TTL_MS,
      emailAttempted,
      mailerEnabled: mailer.enabled(),
    });
  }
);

// Self-service "forgot password". A member (or anyone who can type their
// username / email) hits this anonymously. The response is always the same
// generic 200 — we never confirm or deny whether the account exists, which
// prevents using this as an enumeration oracle.
//
// Flow when the request is legitimate:
//   - We resolve username-or-email to a single user row.
//   - We mint a fresh single-use token (same table the admin flow uses),
//     invalidating any previously unissued token for the same user.
//   - We call mailer.sendResetEmail. If SMTP isn't configured the mailer
//     writes the link to the service journal with a LOG-ONLY tag — admins
//     reading journalctl can still help the member.
//   - We log the event in audit_log. We never log the token itself.
//
// Heavy rate limit (`authLimiter`) prevents abuse.
app.post("/api/auth/forgot-password", authLimiter, async (req, res) => {
  const body = req.body || {};
  const handle = String(body.usernameOrEmail || body.identifier || "").trim();
  // Always respond the same way regardless of what happens below. The
  // "did we find you?" answer is deliberately invisible to the caller.
  const GENERIC_OK = {
    ok: true,
    message:
      "If that account exists and has an email on file, a reset link is on its way. If you don't receive it soon, ask an admin on Discord for a manual link.",
  };
  if (!handle) return res.status(200).json(GENERIC_OK);
  if (handle.length > 254) return res.status(200).json(GENERIC_OK);

  // Try email first (more specific), then username. Both lookups are
  // case-insensitive so users aren't punished for capitalization mistakes.
  let row = null;
  if (handle.includes("@")) {
    row = db
      .prepare(
        `SELECT * FROM users
          WHERE email = ? COLLATE NOCASE
          LIMIT 1`
      )
      .get(handle.toLowerCase());
  }
  if (!row) {
    const u = normUser(handle);
    if (u) row = getUserByUsername(u);
  }

  // Silent no-op for unknown accounts, accounts with no email, and
  // accounts whose email is present-but-unverified. The last case is
  // the whole point of v1.8.0: without it, a hostile member could set
  // their own `email` column to `victim@gmail.com` and redirect reset
  // links to the victim. Admins can still mint a manual token via
  // POST /api/admin/members/:u/reset-token, so unverified users
  // aren't permanently locked out — they just have to talk to a
  // human like they did before v1.7.0.
  if (!row || !row.email || !row.email_verified_at) {
    let reason = "no_user";
    if (row && !row.email) reason = "no_email";
    else if (row && row.email && !row.email_verified_at) reason = "email_unverified";
    auditLog(
      row ? row.username : "anon",
      "auth.forgot_password.noop",
      null,
      { reason },
      req.clientIp
    );
    return res.status(200).json(GENERIC_OK);
  }

  const now = Date.now();
  const token = generateResetToken();
  const expiresAt = now + RESET_TOKEN_TTL_MS;
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE password_reset_tokens
          SET used_at = ?
        WHERE username = ? AND used_at IS NULL`
    ).run(now, row.username);
    db.prepare(
      `INSERT INTO password_reset_tokens
          (token, username, issued_by, issued_at, expires_at)
        VALUES (?, ?, ?, ?, ?)`
    ).run(token, row.username, row.username, now, expiresAt);
  });
  tx();

  // Fire-and-forget the mail; we never block the response on SMTP so a
  // slow relay can't be used to probe for valid accounts via timing.
  mailer
    .sendResetEmail({
      to: row.email,
      username: row.username,
      token,
      issuedBy: row.username,
      expiresAt,
    })
    .then((result) => {
      auditLog(
        row.username,
        "auth.forgot_password.issue",
        null,
        { via: result.via, sent: !!result.sent, expiresAt },
        req.clientIp
      );
    })
    .catch((err) => {
      auditLog(
        row.username,
        "auth.forgot_password.issue",
        null,
        { via: "smtp", sent: false, error: String(err && err.message) },
        req.clientIp
      );
    });

  return res.status(200).json(GENERIC_OK);
});

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
  notifyAccountChange(row.username, "password.reset", req);
  ok(res, { username: row.username });
});

// --------------------------------------------------------------------------
// Email verification (v1.8.0)
// --------------------------------------------------------------------------

// Let a logged-in member request a fresh verification mail. Useful when
// the original message got lost, or they waited >24h. Rate-limited by
// the general authLimiter because this endpoint reaches out to SMTP.
app.post(
  "/api/me/email/send-verification",
  authLimiter,
  requireAuth,
  (req, res) => {
    const email = req.user.email || "";
    if (!email) {
      return fail(res, 400, "No email on file. Add one in your profile first.");
    }
    if (req.user.email_verified_at) {
      return ok(res, { alreadyVerified: true, email });
    }
    const r = issueEmailVerification(
      req.user.username,
      email,
      req.user.username,
      req.clientIp
    );
    ok(res, {
      email,
      expiresAt: r.expiresAt,
      expiresInMs: EMAIL_VERIFY_TTL_MS,
      mailerEnabled: mailer.enabled(),
    });
  }
);

// Redeem a verification token. Public — the member might click the
// link on a different device from the one they signed up on. We do
// confirm the email in the token still matches what's on the user
// row; if the member changed their email between issuance and click,
// this token is dead and the UI shows a helpful error.
app.post("/api/auth/verify-email", authLimiter, (req, res) => {
  const token = String((req.body && req.body.token) || "").trim();
  if (!token) return fail(res, 400, "Missing verification token.");
  const row = db
    .prepare(
      `SELECT token, username, email, expires_at, used_at
         FROM email_verification_tokens
        WHERE token = ?`
    )
    .get(token);
  const now = Date.now();
  if (!row || row.used_at || row.expires_at < now) {
    return fail(res, 400, "That verification link is invalid or has expired.");
  }
  const user = getUserByUsername(row.username);
  if (!user) {
    // User was deleted after the token was issued. Mark the token used
    // to prevent it lingering and return the generic error.
    db.prepare(
      `UPDATE email_verification_tokens SET used_at = ? WHERE token = ?`
    ).run(now, token);
    return fail(res, 400, "That verification link is invalid or has expired.");
  }
  // The email on the user row must still match what the token was issued
  // for. If it was changed, a new verification is pending somewhere else
  // and this one is stale.
  if ((user.email || "") !== row.email) {
    db.prepare(
      `UPDATE email_verification_tokens SET used_at = ? WHERE token = ?`
    ).run(now, token);
    return fail(
      res,
      400,
      "That link was issued for a different email address. Request a fresh verification email from your dashboard."
    );
  }
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE users SET email_verified_at = ? WHERE username = ?`
    ).run(now, row.username);
    db.prepare(
      `UPDATE email_verification_tokens SET used_at = ? WHERE token = ?`
    ).run(now, token);
  });
  tx();
  auditLog(
    row.username,
    "auth.email_verification.complete",
    null,
    { email: row.email },
    req.clientIp
  );
  ok(res, { username: row.username, email: row.email, verifiedAt: now });
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
      `SELECT username, ign, squad, club_role, games_json, photo_data_url, photo_sha256,
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
              player_count, rank_points, challonge_url, source,
              verified_at, created_at
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
    const game = r.game || "Beyblade X";
    const nonScoring = nonScoringReason(game, playerCount);
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
      game,
      rank: r.rank,
      rankCode: r.rank_code || "",
      placement: r.placement || 0,
      playerCount,
      isGrandTournament: isGrandTournament(playerCount),
      // v1.24.0 — Beyblade X rows with <12 participants still render on
      // the portfolio (they happened, they're part of the blader's
      // history) but do not score. Surface the exact reason so the UI
      // can show a clear badge instead of guessing from rankPoints=0.
      countsTowardRanking: !nonScoring,
      nonScoringReason: nonScoring,
      rankPoints: r.rank_points,
      challongeUrl: r.challonge_url,
      source: r.source || "manual",
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
      photoUrl: blobUrl(userRow.photo_sha256 || ""),
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

app.patch("/api/me/profile", requireAuth, async (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (typeof body.photoDataUrl === "string") {
    // v1.23.0 — profile photos go straight to the blob store. If the
    // client cleared the avatar (empty string) we null both columns;
    // if they sent a non-data-url string (e.g. a pre-existing sha URL
    // echoed back) we just ignore it since putBlobFromDataUrl returns
    // null for non-data-url input.
    const raw = body.photoDataUrl.slice(0, MAX_PHOTO_URL);
    if (!raw) {
      patch.photo_data_url = "";
      patch.photo_sha256 = "";
    } else {
      const blob = blobStore.putBlobFromDataUrl(raw);
      if (blob) {
        patch.photo_sha256 = blob.sha256;
        patch.photo_data_url = "";
      } else {
        // Non-image payload — store nothing rather than keeping a
        // legacy data URL that the rest of the stack won't serve.
        patch.photo_data_url = "";
        patch.photo_sha256 = "";
      }
    }
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
  // Members can set or clear their own email. Clearing is explicit:
  // empty string (or null) wipes the stored value; a non-empty value
  // must pass validation. Any change to the address resets the
  // `email_verified_at` flag — a proven-ownership click shouldn't
  // carry over onto a different mailbox.
  let emailChanged = false;
  let newEmail = null;
  if (body.email != null) {
    const raw = String(body.email).trim();
    const currentEmail = req.user.email || "";
    if (!raw) {
      if (currentEmail) emailChanged = true;
      patch.email = "";
      patch.email_verified_at = null;
    } else {
      const e = normEmail(raw);
      if (!e) {
        return fail(res, 400, "That email address doesn't look valid.");
      }
      if (e !== currentEmail) {
        emailChanged = true;
        newEmail = e;
        patch.email = e;
        patch.email_verified_at = null;
      }
    }
  }
  // v1.11.0: mutating the recovery address is a "change that can take
  // over the account via the password-reset flow", so we force a
  // password re-entry before we touch the row. A logged-in session
  // with a sticky cookie should not be able to redirect recovery
  // silently. Applies to both setting *and* clearing the address.
  if (emailChanged) {
    const currentPassword = String(body.currentPassword || "");
    let good = false;
    try {
      good = await verifyPassword(
        currentPassword,
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
        "email.change.fail",
        null,
        { reason: "bad_password" },
        req.clientIp
      );
      return fail(
        res,
        401,
        "Enter your current password to change the email on the account."
      );
    }
  }

  const keys = Object.keys(patch);
  if (!keys.length) return ok(res, { user: profileFromRow(req.user) });
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE users SET ${sets} WHERE username = @username`).run({
    ...patch,
    username: req.user.username,
  });
  const updated = getUserByUsername(req.user.username);
  // If the email was changed, notify the *old* (verified) address
  // before we issue the new verification token — the whole point of
  // this notification is that the previous owner of the account,
  // whose mailbox we can still reach, should hear about the change.
  // The new address gets the standard verification flow from
  // issueEmailVerification; no security notice to it because it isn't
  // proven yet.
  if (emailChanged && req.user.email && req.user.email_verified_at) {
    mailer
      .sendSecurityNotification({
        to: req.user.email,
        username: req.user.username,
        event: "email.change",
        detail: newEmail
          ? `New address: ${newEmail}`
          : "The email has been removed from the account.",
        ip: req.clientIp,
        when: Date.now(),
      })
      .catch(() => {});
  }
  if (emailChanged && newEmail) {
    issueEmailVerification(
      req.user.username,
      newEmail,
      req.user.username,
      req.clientIp
    );
  }
  ok(res, {
    user: profileFromRow(updated),
    emailPending: emailChanged && !!newEmail,
  });
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
  notifyAccountChange(req.user.username, "password.change", req);
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
// v1.23.0 — content-addressed blob endpoint. Serves any image whose
// sha256 is referenced by a row the caller is allowed to see. Public
// blobs (user avatars + verified achievement posters) bypass auth;
// private blobs (pending posters, JLAP cert/QR, ID-flag evidence)
// need the owner's session cookie or a staff role. Auth policy is
// computed in blobStore.canServeBlob(). Cache-Control is "immutable"
// because sha256 is the identity: any change to the bytes yields a
// different URL, so a far-future expiry is always safe.
app.get("/api/blob/:sha256", (req, res) => {
  const sha = String(req.params.sha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) {
    return fail(res, 400, "Bad blob id.");
  }
  maybeAttachUser(req);
  const perm = blobStore.canServeBlob(req, sha);
  if (!perm.ok) {
    // 404 over 403 here on purpose: enumerating valid-but-forbidden
    // sha256s would let an anonymous caller test whether a private
    // image exists. Treat "no access" identically to "no such blob".
    return fail(res, 404, "Not found.");
  }
  const meta = blobStore.getBlobPath(sha);
  if (!meta) {
    return fail(res, 404, "Not found.");
  }
  // Strong ETag = first 32 hex of the content hash. That's enough
  // entropy for an etag (128 bits) and matches the shape of the URL
  // segment so debugging is trivial.
  const etag = '"' + sha.slice(0, 32) + '"';
  if (req.headers["if-none-match"] === etag) {
    return res.status(304).end();
  }
  res.set("ETag", etag);
  res.set("Content-Type", meta.mime);
  res.set("Content-Length", String(meta.size));
  res.set(
    "Cache-Control",
    (perm.public ? "public" : "private") +
      ", max-age=604800, immutable"
  );
  // HEAD requests should get the headers but no body. Express already
  // handles that when we stream via createReadStream + pipe, but be
  // explicit so we don't open a file descriptor we'll immediately
  // throw away.
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(meta.path).pipe(res);
});

app.get("/api/leaderboard", (req, res) => {
  const rawGame = String((req.query && req.query.game) || "").trim();
  const gameFilter =
    rawGame && rawGame.toLowerCase() !== "all"
      ? ALLOWED_GAMES.find((g) => g.toLowerCase() === rawGame.toLowerCase()) || null
      : null;
  const window = parseSeasonWindow(req.query && req.query.season);
  const cacheKey =
    "lb:" +
    (gameFilter || "all") +
    ":" +
    (window ? String((req.query && req.query.season) || "") : "all");
  return serveLeaderboard(req, res, cacheKey, () => computeLeaderboard(req, gameFilter, window));
});

function computeLeaderboard(req, gameFilter, window) {

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
      `SELECT u.username, u.ign, u.squad, u.club_role, u.photo_data_url, u.photo_sha256, u.games_json,
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
        // v1.23.0 — slim avatar reference. Legacy rows still carry
        // the full base64; migrated rows ship just the short URL.
        photoUrl: blobUrl(r.photo_sha256 || ""),
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
  return {
    leaderboard,
    filters: {
      game: gameFilter || "all",
      season: window ? String((req.query && req.query.season) || "") : "all",
    },
    availableGames: ALLOWED_GAMES.slice(),
  };
}

// v1.16.0: verifier leaderboard. Public, read-only. Ranks the people
// who *did* the verifying — achievements + JLAPs + ID-flag requests
// stamped `verified` — across two windows (last 90 days and all
// time). The window switch happens server-side so the browser only
// receives the window it asked for.
//
// Shape of each row:
//   { username, ign, role, verifiedCount, lastVerifiedAt }
// Rows with verifiedCount === 0 are filtered out before we return.
// Tied counts are surfaced in the order the SQL engine picks (by
// most-recent activity, since we already ORDER BY lastVerifiedAt);
// the client renders ties with shared rank so it reads correctly.
app.get("/api/verifiers/leaderboard", (req, res) => {
  const rawWindow = String((req.query && req.query.window) || "90d")
    .trim()
    .toLowerCase();
  const windowLabel = rawWindow === "all" ? "all" : "90d";
  const cacheKey = "vlb:" + windowLabel;
  return serveLeaderboard(req, res, cacheKey, () =>
    computeVerifierLeaderboard(windowLabel)
  );
});

function computeVerifierLeaderboard(windowLabel) {
  const WINDOW_90D = 90 * 24 * 60 * 60 * 1000;
  const windowStart = windowLabel === "all" ? 0 : Date.now() - WINDOW_90D;

  // The three tables that record a "verified" event carry the verifier's
  // username in `verified_by` and a timestamp in `verified_at`. A rejected
  // row still has verified_by / verified_at populated, so the COUNT/UNION
  // filters on status explicitly.
  const rows = db
    .prepare(
      `WITH events AS (
         SELECT verified_by AS who, verified_at AS at FROM achievements
          WHERE status = 'verified' AND verified_by IS NOT NULL
            AND COALESCE(verified_at, 0) >= @start
         UNION ALL
         SELECT verified_by, verified_at FROM jlap_submissions
          WHERE status = 'verified' AND verified_by IS NOT NULL
            AND COALESCE(verified_at, 0) >= @start
         UNION ALL
         SELECT verified_by, verified_at FROM id_flag_requests
          WHERE status = 'verified' AND verified_by IS NOT NULL
            AND COALESCE(verified_at, 0) >= @start
       )
       SELECT e.who                     AS username,
              COUNT(*)                  AS verified_count,
              MAX(COALESCE(e.at, 0))    AS last_verified_at,
              u.ign                     AS ign,
              u.role                    AS role,
              u.photo_data_url          AS photo,
              u.photo_sha256            AS photo_sha
         FROM events e
         JOIN users u ON u.username = e.who
        GROUP BY e.who
        ORDER BY verified_count DESC, last_verified_at DESC, u.ign COLLATE NOCASE
        LIMIT 100`
    )
    .all({ start: windowStart });

  const leaderboard = rows
    .filter((r) => (r.verified_count || 0) > 0)
    .map((r) => ({
      username: r.username,
      ign: r.ign || r.username,
      role: r.role || "user",
      photoUrl: blobUrl(r.photo_sha || ""),
      photoDataUrl: r.photo || "",
      verifiedCount: r.verified_count || 0,
      lastVerifiedAt: r.last_verified_at || null,
    }));

  // Dense ranking: ties share a rank, the next distinct count jumps by
  // the number of tied rows ahead. Matches the /api/leaderboard
  // convention so the UI rendering stays symmetric.
  let prev = null;
  let rank = 0;
  let shown = 0;
  for (const row of leaderboard) {
    shown += 1;
    if (row.verifiedCount !== prev) {
      rank = shown;
      prev = row.verifiedCount;
    }
    row.rank = rank;
  }

  return {
    leaderboard,
    window: windowLabel,
    generatedAt: Date.now(),
  };
}

function mapAchievement(r, opts) {
  const playerCount = r.player_count || 0;
  const posterLegacy = r.poster_data_url || "";
  const posterSha = r.poster_sha256 || "";
  const posterUrl = blobUrl(posterSha);
  const game = r.game || "Beyblade X";
  // v1.24.0 — a verified row below the Beyblade participant floor stays
  // on the portfolio but does NOT score. Surface this explicitly so the
  // frontend can show a "does not count toward leaderboard" pill instead
  // of silently hiding the row.
  const nonScoring = nonScoringReason(game, playerCount);
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
    game,
    rank: r.rank,
    rankCode: r.rank_code || "",
    placement: r.placement || 0,
    playerCount,
    isGrandTournament: isGrandTournament(playerCount),
    countsTowardRanking: !nonScoring,
    nonScoringReason: nonScoring,
    rankPoints: r.rank_points,
    challongeUrl: r.challonge_url,
    // v1.26.0: 'manual' (default, every pre-v1.26 row) or 'challonge'
    // — the latter means the server saw a live Challonge snapshot at
    // ingest time and stamped the row. Drives the
    // "Verified from Challonge" pill on the portfolio / dashboard.
    source: r.source || "manual",
    hasPoster: !!(posterUrl || posterLegacy),
    status: r.status,
    verifierNote: r.verifier_note,
    createdAt: r.created_at,
    verifiedAt: r.verified_at,
    verifiedBy: r.verified_by,
    appealStatus: r.appeal_status || "",
    appealText: r.appeal_text || "",
    appealSubmittedAt: r.appeal_submitted_at || null,
    appealResolvedAt: r.appeal_resolved_at || null,
    appealResolvedBy: r.appeal_resolved_by || "",
    appealVerifierNote: r.appeal_verifier_note || "",
  };
  // v1.23.0 — posterUrl is a short "/api/blob/<sha>" reference when
  // the row has been migrated; posterDataUrl still carries the full
  // base64 for legacy rows. Clients should prefer posterUrl. Both
  // fields are always strings so downstream checks stay simple.
  if (!opts || !opts.lite) {
    base.posterUrl = posterUrl;
    base.posterDataUrl = posterLegacy;
  } else {
    // Slim list view: the URL is cheap, the data URL is not. We
    // still send posterUrl so the verifier queue can render a
    // thumbnail without a second round-trip.
    base.posterUrl = posterUrl;
  }
  return base;
}

function mapJlap(r, opts) {
  const certLegacy = r.certificate_data_url || "";
  const qrLegacy = r.qr_data_url || "";
  const certUrl = blobUrl(r.certificate_sha256 || "");
  const qrUrl = blobUrl(r.qr_sha256 || "");
  const base = {
    id: r.id,
    username: r.username,
    ign: r.user_ign || "",
    type: "jlap",
    hasCertificate: !!(certUrl || certLegacy),
    hasQr: !!(qrUrl || qrLegacy),
    status: r.status,
    verifierNote: r.verifier_note,
    createdAt: r.created_at,
    verifiedAt: r.verified_at,
    verifiedBy: r.verified_by,
    expiresAt: r.expires_at == null ? null : Number(r.expires_at),
    appealStatus: r.appeal_status || "",
    appealText: r.appeal_text || "",
    appealSubmittedAt: r.appeal_submitted_at || null,
    appealResolvedAt: r.appeal_resolved_at || null,
    appealResolvedBy: r.appeal_resolved_by || "",
    appealVerifierNote: r.appeal_verifier_note || "",
  };
  if (!opts || !opts.lite) {
    base.certificateUrl = certUrl;
    base.certificateDataUrl = certLegacy;
    base.qrUrl = qrUrl;
    base.qrDataUrl = qrLegacy;
  } else {
    base.certificateUrl = certUrl;
    base.qrUrl = qrUrl;
  }
  return base;
}

// Fetch all evidence rows for an id_flag_requests row. `withPhoto=false`
// returns the slim list view the verifier queue needs (booleans only so
// the JSON stays small); `withPhoto=true` returns the full base64 data URL
// for the lightbox preview on /api/id-flags/:id.
function loadEvidenceForRequest(requestId, withPhoto) {
  const rows = db
    .prepare(
      `SELECT id, request_id, game, league, photo_data_url, photo_sha256,
              link_url, note, created_at
         FROM id_flag_evidence
        WHERE request_id = ?
        ORDER BY created_at ASC`
    )
    .all(requestId);
  return rows.map((r) => {
    const photoLegacy = r.photo_data_url || "";
    const photoUrl = blobUrl(r.photo_sha256 || "");
    const out = {
      id: r.id,
      requestId: r.request_id,
      game: r.game,
      league: r.league || "",
      leagueLabel: BEYBLADE_LEAGUE_LABELS[r.league] || "",
      linkUrl: r.link_url || "",
      hasPhoto: !!(photoUrl || photoLegacy),
      note: r.note || "",
      createdAt: r.created_at,
      // Always emit the URL (cheap); the full legacy inline only on
      // request (verifier lightbox).
      photoUrl: photoUrl,
    };
    if (withPhoto) out.photoDataUrl = photoLegacy;
    return out;
  });
}

function mapIdFlag(r, opts) {
  const proGames = readProGames(r);
  const base = {
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
    appealStatus: r.appeal_status || "",
    appealText: r.appeal_text || "",
    appealSubmittedAt: r.appeal_submitted_at || null,
    appealResolvedAt: r.appeal_resolved_at || null,
    appealResolvedBy: r.appeal_resolved_by || "",
    appealVerifierNote: r.appeal_verifier_note || "",
  };
  if (opts && opts.withEvidence) {
    base.evidence = loadEvidenceForRequest(r.id, !!opts.withPhotos);
  }
  return base;
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

// v1.26.0 — Challonge bracket auto-fetch preview. Members paste the
// tournament URL from their dashboard form; we resolve it against
// Challonge's unauthenticated `<slug>.json` endpoint and echo back
// the normalized fields (name, participant count, completed_at,
// state) so the client can pre-fill the submission form. Cached for
// 24 h in `challonge_cache` so a popular tournament URL never hits
// Challonge more than once a day from our box.
app.post(
  "/api/achievements/challonge/preview",
  requireAuth,
  challongePreviewLimiter,
  async (req, res) => {
    const url = String((req.body && req.body.url) || "").trim();
    if (!url) return fail(res, 400, "Provide a Challonge URL.");
    const parsed = challonge.parseUrl(url);
    if (parsed.error) return fail(res, 400, parsed.error);

    let result;
    try {
      result = await challonge.resolve(parsed.canonical, { db });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("challonge.resolve threw:", e.message);
      return fail(res, 502, "Could not reach Challonge right now.");
    }
    if (!result.ok) {
      const httpStatus = result.status === 404 ? 404 : 502;
      return fail(res, httpStatus, result.error);
    }
    ok(res, {
      fromCache: !!result.fromCache,
      canonicalUrl: result.canonicalUrl,
      tournament: result.data,
    });
  }
);

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

  const rankPoints = computeAchievementPoints(
    rankCode,
    placement,
    playerCount,
    game
  );
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

  // v1.23.0 — if the uploader gave us a base64 data URL, move it to
  // the blob store immediately and drop the inline copy. This keeps
  // the row slim and means /api/leaderboard / list endpoints never
  // carry the poster bytes again. We still accept the legacy field
  // name (posterDataUrl) from old clients; new clients may also send
  // posterSha256 for a pre-uploaded blob, though no caller does that
  // today.
  const posterBlob = blobStore.putBlobFromDataUrl(posterDataUrl);
  const posterSha256 = posterBlob ? posterBlob.sha256 : "";
  const posterDataUrlStored = posterBlob ? "" : posterDataUrl;

  // v1.26.0 — stamp source='challonge' only if:
  //   1. the URL is a syntactically valid Challonge link, AND
  //   2. the preview endpoint has a fresh (<24h) cache row for it.
  // Clause 2 means the client had to actually call the preview before
  // submitting, which means we saw the tournament exist at fetch
  // time. A user can still paste a URL and skip the preview — the row
  // is accepted as source='manual'. A user CAN'T fake the pill by
  // pasting a random URL; the cache acts as our "we looked at it"
  // receipt.
  const source =
    challongeUrl && challonge.hasFreshCache(challongeUrl, { db })
      ? "challonge"
      : "manual";

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
    poster_data_url: posterDataUrlStored,
    poster_sha256: posterSha256,
    game,
    source,
    status: "pending",
    verifier_note: "",
    created_at: Date.now(),
    verified_at: null,
    verified_by: null,
  };
  db.prepare(
    `INSERT INTO achievements (
      id, username, event_name, event_date, rank, rank_code, placement, player_count,
      rank_points, challonge_url, poster_data_url, poster_sha256, game, source, status, verifier_note,
      created_at, verified_at, verified_by
    ) VALUES (@id, @username, @event_name, @event_date, @rank, @rank_code, @placement,
              @player_count, @rank_points, @challonge_url, @poster_data_url, @poster_sha256,
              @game, @source, @status, @verifier_note, @created_at, @verified_at, @verified_by)`
  ).run(row);
  notifyStaff(
    "queue.achievement",
    "New achievement to review",
    'A new "' + eventName + '" submission needs a verifier.',
    "verifier.html#achievements",
    { excludeUsername: req.user.username }
  );
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
  // v1.24.0: scoring now also consults the tournament's game so the Beyblade
  // X minimum-participant threshold is enforced at approval time — a late-
  // edited player_count drop below 12 will cancel the leaderboard points
  // without deleting the row.
  const canonicalPoints = existing.rank_code
    ? computeAchievementPoints(
        existing.rank_code,
        existing.placement,
        existing.player_count,
        existing.game
      )
    : LEGACY_RANK_POINTS[existing.rank] || 0;
  const pointsDelta =
    status === "verified" && existing.status !== "verified"
      ? canonicalPoints
      : 0;

  // v1.24.0 — transitions INTO status='rejected' reset the appeal
  // fields so the blader always gets one fresh appeal per rejection
  // cycle. Transitions to 'verified' leave the old appeal metadata
  // intact as historical record (it already concluded with
  // appeal_status='accepted' or similar).
  const clearAppeal =
    status === "rejected" && existing.status !== "rejected";
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE achievements
          SET status = ?, rank_points = ?, verifier_note = ?, verified_at = ?, verified_by = ?, event_date = ?,
              appeal_text = CASE WHEN ? = 1 THEN '' ELSE appeal_text END,
              appeal_status = CASE WHEN ? = 1 THEN '' ELSE appeal_status END,
              appeal_submitted_at = CASE WHEN ? = 1 THEN NULL ELSE appeal_submitted_at END,
              appeal_resolved_at = CASE WHEN ? = 1 THEN NULL ELSE appeal_resolved_at END,
              appeal_resolved_by = CASE WHEN ? = 1 THEN '' ELSE appeal_resolved_by END,
              appeal_verifier_note = CASE WHEN ? = 1 THEN '' ELSE appeal_verifier_note END
        WHERE id = ?`
    ).run(
      status,
      canonicalPoints,
      note || (status === "verified" ? "Approved" : ""),
      Date.now(),
      req.user.username,
      eventDate,
      clearAppeal ? 1 : 0,
      clearAppeal ? 1 : 0,
      clearAppeal ? 1 : 0,
      clearAppeal ? 1 : 0,
      clearAppeal ? 1 : 0,
      clearAppeal ? 1 : 0,
      id
    );
    if (pointsDelta) {
      db.prepare(
        `UPDATE users SET points = points + ? WHERE username = ?`
      ).run(pointsDelta, existing.username);
    }
  });
  tx();

  if (existing.status !== status) bumpLeaderboardVersion();

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

  // v1.15.0: require a verified email on file BEFORE accepting a JLAP
  // submission. A verified JLAP auto-grants the Certified Judge pill,
  // and any future "flag on hold" event (see server/reconcile-flags-v114.js)
  // needs a reachable channel outside the app. Without an email the
  // inbox notification is the only signal, which a user who rarely
  // logs in can miss indefinitely. Gating at the submission step keeps
  // the invariant simple: every Judge in the system has a mailable
  // address on file from day one.
  if (!(req.user.email && req.user.email_verified_at)) {
    return fail(
      res,
      400,
      "Add and verify an email on your Dashboard → Account card before " +
        "submitting a JLAP package. We send the 'your flag is on hold' " +
        "notification there if we ever need to revisit a Judge grant."
    );
  }

  const pending = db
    .prepare(
      `SELECT COUNT(*) AS c FROM jlap_submissions WHERE username = ? AND status = 'pending'`
    )
    .get(req.user.username).c;
  if (pending >= MAX_PENDING_JLAP_PER_USER) {
    return fail(res, 429, "You already have a pending JLAP submission.");
  }

  // v1.23.0 — move cert + QR into the blob store at ingest so list
  // endpoints stay slim. See the identical rationale on the
  // achievements POST above.
  const certBlob = blobStore.putBlobFromDataUrl(cert);
  const qrBlob = blobStore.putBlobFromDataUrl(qr);
  const row = {
    id: uid("jlap_"),
    username: req.user.username,
    certificate_data_url: certBlob ? "" : cert,
    certificate_sha256: certBlob ? certBlob.sha256 : "",
    qr_data_url: qrBlob ? "" : qr,
    qr_sha256: qrBlob ? qrBlob.sha256 : "",
    status: "pending",
    verifier_note: "",
    created_at: Date.now(),
    verified_at: null,
    verified_by: null,
  };
  db.prepare(
    `INSERT INTO jlap_submissions (
      id, username, certificate_data_url, certificate_sha256, qr_data_url, qr_sha256, status,
      verifier_note, created_at, verified_at, verified_by
    ) VALUES (@id, @username, @certificate_data_url, @certificate_sha256, @qr_data_url, @qr_sha256, @status,
              @verifier_note, @created_at, @verified_at, @verified_by)`
  ).run(row);
  notifyStaff(
    "queue.jlap",
    "New JLAP package to review",
    req.user.username + " submitted a JLAP certificate + QR.",
    "verifier.html#jlap",
    { excludeUsername: req.user.username }
  );
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

  // v1.17.0: the verifier can optionally set an expiry on approval.
  // Accepted shapes:
  //   - ISO string "2027-04-23"          (parsed as UTC midnight)
  //   - epoch millis (number or numeric string in the future)
  //   - falsy  -> null  (indefinite — matches legacy behaviour)
  // Negative / past values are rejected so a verifier can't "approve
  // then instantly demote" by accident. The column is only written on
  // status=verified; rejections leave whatever was there (always null
  // in practice since pending rows can't have expires_at either).
  let expiresAt = null;
  if (status === "verified" && b.expiresAt != null && b.expiresAt !== "") {
    const raw = b.expiresAt;
    let ms = null;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      ms = Math.floor(raw);
    } else if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (/^\d+$/.test(trimmed)) {
        ms = parseInt(trimmed, 10);
      } else {
        const parsed = Date.parse(trimmed);
        if (!Number.isNaN(parsed)) ms = parsed;
      }
    }
    if (ms == null || !Number.isFinite(ms)) {
      return fail(
        res,
        400,
        "expiresAt must be an ISO date string or epoch millisecond timestamp."
      );
    }
    if (ms <= Date.now()) {
      return fail(res, 400, "expiresAt must be in the future.");
    }
    expiresAt = ms;
  }

  // Transaction boundary: the JLAP row and the user's certified_judge flag
  // flip as a single atomic unit so a crash between the two statements can
  // never leave us with a "verified" JLAP against a user who still isn't a
  // judge. The `judgeGranted` flag is read outside the transaction for
  // audit/notify side effects.
  let judgeGranted = false;
  // v1.24.0 — see matching comment in the achievements PATCH handler.
  const clearAppeal =
    status === "rejected" && existing.status !== "rejected";
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE jlap_submissions
          SET status = ?, verifier_note = ?, verified_at = ?, verified_by = ?,
              expires_at = CASE WHEN ? = 'verified' THEN ? ELSE expires_at END,
              appeal_text = CASE WHEN ? = 1 THEN '' ELSE appeal_text END,
              appeal_status = CASE WHEN ? = 1 THEN '' ELSE appeal_status END,
              appeal_submitted_at = CASE WHEN ? = 1 THEN NULL ELSE appeal_submitted_at END,
              appeal_resolved_at = CASE WHEN ? = 1 THEN NULL ELSE appeal_resolved_at END,
              appeal_resolved_by = CASE WHEN ? = 1 THEN '' ELSE appeal_resolved_by END,
              appeal_verifier_note = CASE WHEN ? = 1 THEN '' ELSE appeal_verifier_note END
        WHERE id = ?`
    ).run(
      status,
      note || (status === "verified" ? "JLAP verified" : ""),
      Date.now(),
      req.user.username,
      status,
      expiresAt,
      clearAppeal ? 1 : 0,
      clearAppeal ? 1 : 0,
      clearAppeal ? 1 : 0,
      clearAppeal ? 1 : 0,
      clearAppeal ? 1 : 0,
      clearAppeal ? 1 : 0,
      id
    );
    if (status === "verified") {
      const target = db
        .prepare(`SELECT certified_judge FROM users WHERE username = ?`)
        .get(existing.username);
      if (target && !target.certified_judge) {
        db.prepare(
          `UPDATE users SET certified_judge = 1 WHERE username = ?`
        ).run(existing.username);
        judgeGranted = true;
      }
    }
  });
  tx();

  if (existing.status !== status || judgeGranted) bumpLeaderboardVersion();

  auditLog(
    req.user.username,
    "jlap." + status,
    id,
    { member: existing.username, judgeGranted, expiresAt },
    req.clientIp
  );
  if (judgeGranted) {
    auditLog(
      req.user.username,
      "jlap.judge.granted",
      id,
      { member: existing.username },
      req.clientIp
    );
  }
  if (existing.status !== status) {
    if (status === "verified") {
      notify(
        existing.username,
        "jlap",
        judgeGranted ? "JLAP approved — Certified Judge granted" : "JLAP approved",
        judgeGranted
          ? "Your JLAP certificate was verified by " +
              req.user.username +
              ". The Certified Judge flag is now on your digital ID."
          : "Your JLAP certificate was verified by " + req.user.username + ".",
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
    pending: pending ? mapIdFlag(pending, { withEvidence: true }) : null,
    latest: latest ? mapIdFlag(latest, { withEvidence: true }) : null,
    history: rows.map((r) => mapIdFlag(r)),
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
  const hasJudge = !!req.user.certified_judge;

  // v1.14.0: Certified Judge is granted only by JLAP approval. A user may
  // still self-relinquish the flag through this endpoint (1 -> 0), but
  // attempting to claim it here (0 -> 1) is rejected with a pointer at
  // the JLAP upload form.
  if (wantCj && !hasJudge) {
    return fail(
      res,
      400,
      "The Certified Judge flag is granted automatically when a Verifier " +
        "approves your JLAP package. Upload your certificate + QR under " +
        "Dashboard → JLAP certification instead."
    );
  }

  if (
    wantCj === hasJudge &&
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

  // v1.14.0: every newly-claimed PRO game needs evidence. Existing claims
  // can be re-submitted without fresh proof — this is a policy about
  // *adding* a pill, not about keeping one. We sanitise the client list
  // first so oversized payloads can't sneak through, then match each
  // added game to an evidence entry.
  const addedPro = wantProGames.filter((g) => !currentProGames.includes(g));
  const evidenceIn = Array.isArray(b.evidence) ? b.evidence : [];
  const evidenceClean = [];
  const evidenceByGame = new Map();
  for (const raw of evidenceIn) {
    const e = sanitizeEvidenceEntry(raw);
    if (!e) continue;
    if (!wantProGames.includes(e.game)) continue; // ignore stale / wrong-game
    if (!evidenceByGame.has(e.game)) {
      evidenceByGame.set(e.game, e);
      evidenceClean.push(e);
    }
  }
  for (const game of addedPro) {
    const reason = validateNewGameEvidence(game, evidenceByGame.get(game));
    if (reason) return fail(res, 400, reason);
  }

  // v1.15.0: adding any new PRO pill requires a verified email, matching
  // the JLAP submission guard. The check runs AFTER evidence validation
  // so a user who fixes evidence problems doesn't need to re-discover
  // that they also lack a verified email only at the very end — they
  // see both errors in sequence. Downgrade-only requests (addedPro is
  // empty) are left alone so a user who only wants to drop a pill isn't
  // blocked on admin.
  if (addedPro.length > 0 && !(req.user.email && req.user.email_verified_at)) {
    return fail(
      res,
      400,
      "Add and verify an email on your Dashboard → Account card before " +
        "claiming a new Professional pill. We send the 'your flag is " +
        "on hold' notification there if we ever need to revisit the grant."
    );
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

  const insertRequest = db.prepare(
    `INSERT INTO id_flag_requests (
      id, username, certified_judge, professional_blader, pro_games_json, status,
      verifier_note, created_at, verified_at, verified_by
    ) VALUES (@id, @username, @certified_judge, @professional_blader, @pro_games_json, @status,
              @verifier_note, @created_at, @verified_at, @verified_by)`
  );
  const insertEvidence = db.prepare(
    `INSERT INTO id_flag_evidence (
      id, request_id, game, league, photo_data_url, photo_sha256, link_url, note, created_at
    ) VALUES (@id, @request_id, @game, @league, @photo_data_url, @photo_sha256, @link_url, @note, @created_at)`
  );
  const now = Date.now();
  // v1.23.0 — move each evidence photo into the blob store at ingest.
  // Kept outside the transaction because putBlobFromDataUrl writes to
  // disk, and better-sqlite3 transactions can't span non-DB side
  // effects cleanly. The worst case on mid-tx failure is an orphan
  // blob file that the GC sweep will reclaim.
  const evidenceRows = evidenceClean.map((e) => {
    const blob = blobStore.putBlobFromDataUrl(e.photoDataUrl);
    return {
      id: uid("idfe_"),
      request_id: row.id,
      game: e.game,
      league: e.league,
      photo_data_url: blob ? "" : e.photoDataUrl,
      photo_sha256: blob ? blob.sha256 : "",
      link_url: e.linkUrl,
      note: e.note,
      created_at: now,
    };
  });
  const tx = db.transaction(() => {
    insertRequest.run(row);
    for (const er of evidenceRows) insertEvidence.run(er);
  });
  tx();

  notifyStaff(
    "queue.idflags",
    "New ID-flag request to review",
    req.user.username + " requested an ID-flag change.",
    "verifier.html#idflags",
    { excludeUsername: req.user.username }
  );
  ok(res, { request: mapIdFlag(row, { withEvidence: true }) });
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
  // Evidence is returned in slim form (booleans + link URLs, no base64
  // photos) so the queue stays compact even with dozens of pending
  // requests. Verifiers load full photos on demand via GET /api/id-flags/:id.
  ok(res, { requests: rows.map((r) => mapIdFlag(r, { withEvidence: true })) });
});

// Single-record fetch used by the verifier lightbox to get the full
// base64 photo data URL per evidence entry. Access: owner always; admins
// and verifiers for any request.
app.get("/api/id-flags/:id", requireAuth, (req, res) => {
  const id = String(req.params.id || "");
  const row = db
    .prepare(
      `SELECT f.*, u.ign AS user_ign
         FROM id_flag_requests f
         LEFT JOIN users u ON u.username = f.username
        WHERE f.id = ?`
    )
    .get(id);
  if (!row) return fail(res, 404, "Not found.");
  const role = req.user.role;
  const canSee =
    role === "admin" || role === "verifier" || row.username === req.user.username;
  if (!canSee) return fail(res, 403, "Forbidden.");
  ok(res, {
    request: mapIdFlag(row, { withEvidence: true, withPhotos: true }),
  });
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

  // v1.24.0 — see matching comment in the achievements PATCH handler.
  const clearAppeal =
    status === "rejected" && existing.status !== "rejected";
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE id_flag_requests
          SET status = ?, verifier_note = ?, verified_at = ?, verified_by = ?,
              appeal_text = CASE WHEN ? = 1 THEN '' ELSE appeal_text END,
              appeal_status = CASE WHEN ? = 1 THEN '' ELSE appeal_status END,
              appeal_submitted_at = CASE WHEN ? = 1 THEN NULL ELSE appeal_submitted_at END,
              appeal_resolved_at = CASE WHEN ? = 1 THEN NULL ELSE appeal_resolved_at END,
              appeal_resolved_by = CASE WHEN ? = 1 THEN '' ELSE appeal_resolved_by END,
              appeal_verifier_note = CASE WHEN ? = 1 THEN '' ELSE appeal_verifier_note END
        WHERE id = ?`
    ).run(
      status,
      note || "Approved",
      Date.now(),
      req.user.username,
      clearAppeal ? 1 : 0,
      clearAppeal ? 1 : 0,
      clearAppeal ? 1 : 0,
      clearAppeal ? 1 : 0,
      clearAppeal ? 1 : 0,
      clearAppeal ? 1 : 0,
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
  if (existing.status !== status) bumpLeaderboardVersion();
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
  ok(res, { request: mapIdFlag(updated, { withEvidence: true }) });
});

// --------------------------------------------------------------------------
// v1.24.0 — Appeal lifecycle (user) + resolve (verifier)
//
// A blader gets ONE appeal per rejection cycle on achievement / JLAP /
// ID-flag submissions. They write up to MAX_APPEAL_TEXT chars explaining
// why they think the rejection was wrong; the row stays status='rejected'
// while appeal_status='pending' so the main verifier queue isn't
// polluted. A separate /api/admin/appeals feed lists them for staff.
//
// A verifier can then:
//   - accept -> row flips to 'pending', appeal_status='accepted',
//               the submission re-enters the main verifier queue.
//   - deny   -> row stays 'rejected', appeal_status='denied'. Terminal.
//
// On any subsequent transition INTO 'rejected' (fresh rejection after a
// previous accept), the three PATCH handlers zero out appeal_* so the
// blader gets a new appeal attempt. That reset is what limits spam: a
// denied appeal is permanent for that rejection cycle.
// --------------------------------------------------------------------------

const MAX_APPEAL_TEXT = 500;
const APPEAL_COOLDOWN_MS = 60 * 1000; // 60s after rejection before appealing
const APPEAL_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const APPEAL_RATE_LIMIT_MAX = 5;

const APPEAL_HOSTS = {
  achievement: {
    table: "achievements",
    label: "achievement",
    notifKind: "achievement",
    link: "dashboard.html",
    titleForUser: (row) => 'Your result "' + row.event_name + '"',
    selectForVerifier: `SELECT a.*, u.ign AS user_ign
         FROM achievements a
         LEFT JOIN users u ON u.username = a.username
        WHERE a.id = ?`,
    remap: (row) => mapAchievement(row),
    onAccept: null,
  },
  jlap: {
    table: "jlap_submissions",
    label: "JLAP submission",
    notifKind: "jlap",
    link: "dashboard.html",
    titleForUser: () => "Your JLAP submission",
    selectForVerifier: `SELECT j.*, u.ign AS user_ign
         FROM jlap_submissions j
         LEFT JOIN users u ON u.username = j.username
        WHERE j.id = ?`,
    remap: (row) => mapJlap(row),
    onAccept: null,
  },
  idflags: {
    table: "id_flag_requests",
    label: "ID flags request",
    notifKind: "idflags",
    link: "dashboard.html",
    titleForUser: () => "Your ID flags request",
    selectForVerifier: `SELECT r.*, u.ign AS user_ign
         FROM id_flag_requests r
         LEFT JOIN users u ON u.username = r.username
        WHERE r.id = ?`,
    remap: (row) => mapIdFlag(row, { withEvidence: true }),
    onAccept: null,
  },
};

function countRecentAppealsByUser(username) {
  const since = Date.now() - APPEAL_RATE_LIMIT_WINDOW_MS;
  const q = (table) =>
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM ${table}
          WHERE username = ? AND appeal_submitted_at IS NOT NULL AND appeal_submitted_at >= ?`
      )
      .get(username, since).c;
  return q("achievements") + q("jlap_submissions") + q("id_flag_requests");
}

function fileAppeal(req, res, hostKey) {
  const host = APPEAL_HOSTS[hostKey];
  if (!host) return fail(res, 400, "Unknown submission type.");
  const id = req.params.id;
  const b = req.body || {};
  const text = typeof b.appealText === "string" ? b.appealText.trim() : "";
  if (!text) return fail(res, 400, "Appeal text is required.");
  if (text.length > MAX_APPEAL_TEXT) {
    return fail(res, 400, "Appeal text is too long (max " + MAX_APPEAL_TEXT + " chars).");
  }

  const row = db.prepare(`SELECT * FROM ${host.table} WHERE id = ?`).get(id);
  if (!row) return fail(res, 404, "Not found.");
  if (row.username !== req.user.username) {
    return fail(res, 403, "You can only appeal your own submissions.");
  }
  if (row.status !== "rejected") {
    return fail(res, 409, "Only rejected submissions can be appealed.");
  }
  if (row.appeal_status) {
    return fail(
      res,
      409,
      row.appeal_status === "pending"
        ? "You already have a pending appeal on this submission."
        : "This rejection has already been appealed once and the decision is final."
    );
  }
  // Cooldown: verifier note needs a moment to sink in before the user
  // fires back. Also stops accidental double-clicks on the appeal button.
  const rejectedAt = row.verified_at || row.created_at || 0;
  if (rejectedAt && Date.now() - rejectedAt < APPEAL_COOLDOWN_MS) {
    return fail(
      res,
      429,
      "Please wait a moment before submitting your appeal."
    );
  }
  if (countRecentAppealsByUser(req.user.username) >= APPEAL_RATE_LIMIT_MAX) {
    return fail(
      res,
      429,
      "You have filed the maximum number of appeals allowed in 24 hours."
    );
  }

  const now = Date.now();
  db.prepare(
    `UPDATE ${host.table}
        SET appeal_text = ?, appeal_status = 'pending',
            appeal_submitted_at = ?,
            appeal_resolved_at = NULL, appeal_resolved_by = '',
            appeal_verifier_note = ''
      WHERE id = ?`
  ).run(text, now, id);

  auditLog(
    req.user.username,
    hostKey + ".appeal.filed",
    id,
    { chars: text.length },
    req.clientIp
  );

  notifyStaff(
    "queue.appeal",
    "New rejection appeal filed",
    req.user.username +
      " is appealing a rejected " +
      host.label +
      ". Review in the appeals queue.",
    "verifier.html#appeals",
    { excludeUsername: req.user.username }
  );

  const fresh = db.prepare(`SELECT * FROM ${host.table} WHERE id = ?`).get(id);
  ok(res, { [hostKey === "idflags" ? "request" : hostKey]: host.remap(fresh) });
}

function resolveAppeal(req, res, hostKey) {
  const host = APPEAL_HOSTS[hostKey];
  if (!host) return fail(res, 400, "Unknown submission type.");
  const id = req.params.id;
  const b = req.body || {};
  const action = b.action === "accept" || b.action === "deny" ? b.action : null;
  if (!action) return fail(res, 400, "action must be 'accept' or 'deny'.");
  const note = typeof b.verifierNote === "string"
    ? b.verifierNote.trim().slice(0, 1000)
    : "";
  if (action === "deny" && !note) {
    return fail(res, 400, "Denying an appeal requires a verifier note explaining why.");
  }

  const row = db.prepare(`SELECT * FROM ${host.table} WHERE id = ?`).get(id);
  if (!row) return fail(res, 404, "Not found.");
  if (row.appeal_status !== "pending") {
    return fail(res, 409, "This submission has no pending appeal.");
  }
  if (row.username === req.user.username) {
    return fail(res, 403, "You can't resolve an appeal on your own submission.");
  }

  const now = Date.now();
  if (action === "accept") {
    // Row flips back to 'pending'. verified_at / verified_by are
    // cleared so the main verifier UI doesn't pretend this row was
    // already reviewed — it needs a fresh look. rank_points already
    // accounts for the rejection (was zeroed on the original PATCH).
    db.prepare(
      `UPDATE ${host.table}
          SET status = 'pending',
              verified_at = NULL,
              verified_by = NULL,
              appeal_status = 'accepted',
              appeal_resolved_at = ?,
              appeal_resolved_by = ?,
              appeal_verifier_note = ?
        WHERE id = ?`
    ).run(now, req.user.username, note, id);
  } else {
    db.prepare(
      `UPDATE ${host.table}
          SET appeal_status = 'denied',
              appeal_resolved_at = ?,
              appeal_resolved_by = ?,
              appeal_verifier_note = ?
        WHERE id = ?`
    ).run(now, req.user.username, note, id);
  }

  auditLog(
    req.user.username,
    hostKey + ".appeal." + action,
    id,
    { member: row.username },
    req.clientIp
  );

  // User-facing inbox nudge. Verifier note is included on deny because
  // the user deserves to know why the appeal didn't carry.
  if (action === "accept") {
    notify(
      row.username,
      host.notifKind,
      host.label.charAt(0).toUpperCase() + host.label.slice(1) + " appeal accepted",
      host.titleForUser(row) +
        " has been re-opened for review by " +
        req.user.username +
        ". It is now back in the verifier queue.",
      host.link
    );
  } else {
    notify(
      row.username,
      host.notifKind,
      host.label.charAt(0).toUpperCase() + host.label.slice(1) + " appeal denied",
      host.titleForUser(row) +
        " appeal was denied by " +
        req.user.username +
        (note ? ". Note: " + note : "."),
      host.link
    );
  }

  if (action === "accept") bumpLeaderboardVersion();

  const fresh = db.prepare(host.selectForVerifier).get(id);
  ok(res, { [hostKey === "idflags" ? "request" : hostKey]: host.remap(fresh) });
}

app.post("/api/achievements/:id/appeal", requireAuth, (req, res) =>
  fileAppeal(req, res, "achievement")
);
app.post("/api/jlap/:id/appeal", requireAuth, (req, res) =>
  fileAppeal(req, res, "jlap")
);
app.post("/api/id-flags/:id/appeal", requireAuth, (req, res) =>
  fileAppeal(req, res, "idflags")
);

app.post(
  "/api/admin/achievements/:id/appeal/resolve",
  requireRole("verifier"),
  (req, res) => resolveAppeal(req, res, "achievement")
);
app.post(
  "/api/admin/jlap/:id/appeal/resolve",
  requireRole("verifier"),
  (req, res) => resolveAppeal(req, res, "jlap")
);
app.post(
  "/api/admin/id-flags/:id/appeal/resolve",
  requireRole("verifier"),
  (req, res) => resolveAppeal(req, res, "idflags")
);

// Verifier-facing feed of all pending appeals across submission types.
// Slim payload: enough to render a "N appeals waiting" badge and the
// appeal-queue table. The single-record PATCH / resolve endpoints load
// full detail when staff clicks through.
app.get("/api/admin/appeals", requireRole("verifier"), (_req, res) => {
  const ach = db
    .prepare(
      `SELECT a.*, u.ign AS user_ign
         FROM achievements a
         LEFT JOIN users u ON u.username = a.username
        WHERE a.appeal_status = 'pending'
        ORDER BY a.appeal_submitted_at ASC`
    )
    .all()
    .map((r) => mapAchievement(r));
  const jlaps = db
    .prepare(
      `SELECT j.*, u.ign AS user_ign
         FROM jlap_submissions j
         LEFT JOIN users u ON u.username = j.username
        WHERE j.appeal_status = 'pending'
        ORDER BY j.appeal_submitted_at ASC`
    )
    .all()
    .map((r) => mapJlap(r));
  const idfs = db
    .prepare(
      `SELECT r.*, u.ign AS user_ign
         FROM id_flag_requests r
         LEFT JOIN users u ON u.username = r.username
        WHERE r.appeal_status = 'pending'
        ORDER BY r.appeal_submitted_at ASC`
    )
    .all()
    .map((r) => mapIdFlag(r));
  ok(res, {
    achievements: ach,
    jlap: jlaps,
    idFlags: idfs,
    total: ach.length + jlaps.length + idfs.length,
  });
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

// --------------------------------------------------------------------------
// Admin security view (v1.13.0)
// --------------------------------------------------------------------------
//
// Gives admins a one-screen picture of a member's security state
// when a support ticket lands on their desk. Returns (a) basic
// account metadata (2FA state, email verification, recovery-code
// remaining), (b) every still-live session including age and IP
// prefix, and (c) the last N security-relevant audit rows actor OR
// target of which is this user.
//
// This endpoint is READ ONLY — any destructive action (password
// reset, disable 2FA, delete user) still goes through its own
// dedicated admin route with its own audit entry. Looking up a
// member's security data does get logged so admins can answer
// "who looked at my audit trail?".

const SECURITY_AUDIT_ACTIONS = [
  "auth.login.ok",
  "auth.login.fail",
  "auth.login.totp_fail",
  "password.change",
  "password.reset",
  "password.reset.requested",
  "password.reset.issued",
  "password.reset.used",
  "2fa.enabled",
  "2fa.disabled",
  "2fa.verify.fail",
  "2fa.disable.fail",
  "2fa.recovery.used",
  "2fa.recovery.regenerated",
  "2fa.recovery.regen.fail",
  "email.change",
  "email.change.fail",
  "email.verify.ok",
  "session.revoke",
  "sessions.revoke_all",
  "account.delete",
  "admin.member.delete",
  "admin.member.update",
  "admin.reset.issued",
  "admin.2fa.disabled",
];

app.get(
  "/api/admin/members/:username/security",
  requireRole("admin"),
  async (req, res) => {
    const username = normUser(req.params.username);
    const user = getUserByUsername(username);
    if (!user) return fail(res, 404, "Not found.");

    const now = Date.now();
    const sessionRows = db
      .prepare(
        `SELECT id, created_at, expires_at, user_agent, ip_address,
                last_seen_at
           FROM sessions
          WHERE username = ? AND expires_at > ?
          ORDER BY COALESCE(last_seen_at, created_at) DESC
          LIMIT 50`
      )
      .all(username, now);

    const locations = await Promise.all(
      sessionRows.map((row) =>
        friendlyLocation(row.ip_address).catch(() => "")
      )
    );
    const sessions = sessionRows.map((row, i) => ({
      idShort: row.id.slice(0, 8),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at,
      browser: friendlyUserAgent(row.user_agent),
      platform: friendlyPlatform(row.user_agent),
      ip: maskIp(row.ip_address),
      location: locations[i] || "",
    }));

    // "Security-relevant" = either a login/2FA/password/email event
    // where the target OR actor is this user, or an admin action
    // that touched this user. We limit to 100 rows to keep the
    // payload bounded; admins wanting deeper history use the
    // existing /api/admin/audit endpoint with an actor/target filter.
    const placeholders = SECURITY_AUDIT_ACTIONS.map(() => "?").join(", ");
    const auditRows = db
      .prepare(
        `SELECT id, actor, action, target, detail_json, ip, created_at
           FROM audit_log
          WHERE action IN (${placeholders})
            AND (actor = ? OR target = ?)
          ORDER BY created_at DESC
          LIMIT 100`
      )
      .all(...SECURITY_AUDIT_ACTIONS, username, username);

    const audit = auditRows.map((row) => {
      let detail = {};
      try {
        detail = row.detail_json ? JSON.parse(row.detail_json) : {};
      } catch (_) {
        detail = { _raw: row.detail_json };
      }
      return {
        id: row.id,
        actor: row.actor,
        action: row.action,
        target: row.target,
        detail,
        ip: maskIp(row.ip),
        createdAt: row.created_at,
      };
    });

    const notifRows = db
      .prepare(
        `SELECT id, kind, title, body, link, read_at, created_at
           FROM notifications
          WHERE username = ? AND kind = 'security'
          ORDER BY created_at DESC
          LIMIT 50`
      )
      .all(username);

    auditLog(
      req.user.username,
      "admin.security.view",
      username,
      { sessions: sessions.length, audit: audit.length },
      req.clientIp
    );

    ok(res, {
      profile: {
        username: user.username,
        role: user.role,
        email: user.email || "",
        emailVerified: !!user.email_verified_at,
        emailVerifiedAt: user.email_verified_at,
        totpEnabled: !!user.totp_enabled,
        recoveryCodesRemaining: user.totp_enabled
          ? countRecoveryCodes(username)
          : 0,
        recoveryCodesTotal: RECOVERY_CODE_COUNT,
        createdAt: user.created_at,
      },
      sessions,
      audit,
      notifications: notifRows.map((row) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        link: row.link,
        readAt: row.read_at,
        createdAt: row.created_at,
      })),
    });
  }
);

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
// v1.20.0 — Staff 2FA rollout tracker
// --------------------------------------------------------------------------
//
// Admin gets one page-level view of who still needs TOTP before the grace
// window closes, and a one-click "nudge" button that drops an inbox entry
// (+ best-effort email) into the staffer's queue. Keeps admins out of the
// DB for rollout visibility and keeps the record on the audit trail.

const STAFF_2FA_NUDGE_KIND = "staff-2fa.nudge";
const STAFF_2FA_NUDGE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 1 day per target

function staff2faNudgeBody(graceUntil) {
  const whenMs = Number(graceUntil);
  let when = "";
  if (Number.isFinite(whenMs) && whenMs > 0) {
    when =
      " The grace window closes on " +
      new Date(whenMs).toISOString().slice(0, 10) +
      ".";
  }
  return (
    "Your verifier/admin account still doesn't have two-factor " +
    "authentication enabled. Head to Dashboard → Security and scan the " +
    "QR with your authenticator app to finish setup." +
    when +
    " After the cutoff every staff action returns 403 until TOTP is on."
  );
}

function staff2faNudgeSendEmail(username, logger = console) {
  if (!mailer || typeof mailer.sendSecurityNotification !== "function") {
    return Promise.resolve({ sent: false, reason: "mailer-unavailable" });
  }
  const row = db
    .prepare("SELECT email, email_verified_at FROM users WHERE username = ?")
    .get(String(username).toLowerCase());
  if (!row || !row.email || !row.email_verified_at) {
    return Promise.resolve({ sent: false, reason: "no-verified-email" });
  }
  return mailer
    .sendSecurityNotification(
      {
        to: row.email,
        username,
        event: "staff-2fa.nudge",
        detail: staff2faNudgeBody(currentStaff2faGrace()),
        ip: "",
        when: Date.now(),
      },
      { logger }
    )
    .catch(() => ({ sent: false }));
}

// v1.22.0 — cache-stats endpoint. Read-only, admin-only. Adds a
// `?reset=1` query option that also zeroes the counters (audit-logged
// so a drive-by refresh can't hide a spike in misses).
app.get("/api/admin/cache-stats", requireRole("admin"), (req, res) => {
  const wantsReset = String(req.query && req.query.reset) === "1";
  const before = snapshotLeaderboardStats();
  if (wantsReset) {
    resetLeaderboardStats();
    auditLog(
      req.user.username,
      "admin.cache-stats.reset",
      "leaderboard",
      {
        priorHits: before.hits,
        priorMisses: before.misses,
        priorNotModified: before.notModified,
        uptimeMs: before.uptimeMs,
      },
      req.clientIp
    );
    return ok(res, { stats: snapshotLeaderboardStats(), reset: true, priorStats: before });
  }
  return ok(res, { stats: before, reset: false });
});

app.get(
  "/api/admin/staff-2fa-status",
  requireRole("admin"),
  (_req, res) => {
    const now = Date.now();
    const grace = currentStaff2faGrace();
    const staff = db
      .prepare(
        `SELECT username, role, totp_enabled, email, email_verified_at, created_at
           FROM users
          WHERE role IN ('verifier','admin')
          ORDER BY role DESC, username ASC`
      )
      .all();
    const lastSeenStmt = db.prepare(
      `SELECT MAX(COALESCE(last_seen_at, created_at)) AS t
         FROM sessions WHERE username = ?`
    );
    const lastDeniedStmt = db.prepare(
      `SELECT MAX(created_at) AS t FROM audit_log
        WHERE target = ? AND action = 'admin.2fa-denied'`
    );
    const lastGraceHitStmt = db.prepare(
      `SELECT MAX(created_at) AS t FROM audit_log
        WHERE target = ? AND action = 'admin.2fa-grace-hit'`
    );
    const lastNudgeStmt = db.prepare(
      `SELECT MAX(created_at) AS t FROM notifications
        WHERE username = ? AND kind = ?`
    );
    const lastNudgeAuditStmt = db.prepare(
      `SELECT MAX(created_at) AS t FROM audit_log
        WHERE target = ? AND action = 'admin.2fa-nudge'`
    );

    const members = staff.map((row) => {
      const ls = lastSeenStmt.get(row.username);
      const ld = lastDeniedStmt.get(row.username);
      const lg = lastGraceHitStmt.get(row.username);
      const ln = lastNudgeStmt.get(row.username, STAFF_2FA_NUDGE_KIND);
      const la = lastNudgeAuditStmt.get(row.username);
      return {
        username: row.username,
        role: row.role,
        totpEnabled: !!row.totp_enabled,
        emailVerified: !!row.email_verified_at,
        hasEmail: !!row.email,
        createdAt: row.created_at,
        lastSeenAt: (ls && ls.t) || null,
        lastDeniedAt: (ld && ld.t) || null,
        lastGraceHitAt: (lg && lg.t) || null,
        lastNudgeAt: Math.max(
          (ln && ln.t) || 0,
          (la && la.t) || 0
        ) || null,
      };
    });

    const withTotp = members.filter((m) => m.totpEnabled).length;
    const withoutTotp = members.length - withTotp;
    const daysLeft =
      grace != null ? Math.max(0, Math.ceil((grace - now) / 86400000)) : null;

    ok(res, {
      staff: members,
      aggregates: {
        totalStaff: members.length,
        withTotp,
        withoutTotp,
        graceUntil: grace,
        graceActive: grace != null && grace > now,
        daysLeft,
        now,
      },
    });
  }
);

app.post(
  "/api/admin/staff-2fa-nudge",
  requireRole("admin"),
  async (req, res) => {
    const body = req.body || {};
    const targetRaw = String(body.target || "").trim().toLowerCase();
    if (!targetRaw) return fail(res, 400, "target is required.");
    const target = getUserByUsername(targetRaw);
    if (!target) return fail(res, 404, "No such user.");
    if (!isStaffRole(target.role)) {
      return fail(res, 400, "Target is not a staff account.");
    }
    if (target.totp_enabled) {
      return fail(res, 400, "Target already has 2FA enabled.");
    }

    const now = Date.now();
    // Cooldown: admin can't spam a single staffer. The cooldown is
    // enforced on both the notifications row and an audit-log echo so a
    // caller can't bypass it by deleting their own inbox row.
    const lastNudge = db
      .prepare(
        `SELECT MAX(created_at) AS t FROM notifications
          WHERE username = ? AND kind = ?`
      )
      .get(target.username, STAFF_2FA_NUDGE_KIND);
    const lastAudit = db
      .prepare(
        `SELECT MAX(created_at) AS t FROM audit_log
          WHERE target = ? AND action = 'admin.2fa-nudge'`
      )
      .get(target.username);
    const lastSent = Math.max(
      (lastNudge && lastNudge.t) || 0,
      (lastAudit && lastAudit.t) || 0
    );
    if (lastSent > 0 && now - lastSent < STAFF_2FA_NUDGE_COOLDOWN_MS) {
      return fail(
        res,
        429,
        "This staff member was already nudged in the last 24 hours."
      );
    }

    notify(
      target.username,
      STAFF_2FA_NUDGE_KIND,
      "Enable two-factor authentication",
      staff2faNudgeBody(currentStaff2faGrace()),
      "dashboard.html#tfa"
    );
    auditLog(
      req.user.username,
      "admin.2fa-nudge",
      target.username,
      { role: target.role, graceUntil: currentStaff2faGrace() },
      req.clientIp
    );

    const mailRes = await staff2faNudgeSendEmail(target.username);
    ok(res, {
      target: target.username,
      emailed: !!(mailRes && mailRes.sent),
      reason: mailRes && mailRes.sent ? null : mailRes && mailRes.reason,
      cooldownMs: STAFF_2FA_NUDGE_COOLDOWN_MS,
    });
  }
);

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

module.exports = {
  app,
  db,
  __resetLeaderboardCacheForTests,
  __setLeaderboardCacheEnabledForTests: (v) => {
    CACHE_ENABLED = !!v;
  },
  __snapshotLeaderboardStatsForTests: snapshotLeaderboardStats,
};
