"use strict";

/**
 * RFC-6238 TOTP (HMAC-SHA1, 30-second step, 6 digits) and RFC-4648 base32,
 * implemented in-house so we don't pull another crypto dependency in.
 * Used by the 2FA setup/verify/login flows in server/index.js.
 */

const crypto = require("crypto");

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf) {
  let out = "";
  let bits = 0;
  let value = 0;
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

function base32Decode(str) {
  const clean = String(str || "")
    .replace(/=+$/g, "")
    .replace(/\s+/g, "")
    .toUpperCase();
  if (!clean) return Buffer.alloc(0);
  const out = [];
  let bits = 0;
  let value = 0;
  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]);
    if (idx < 0) {
      throw new Error("Invalid base32 character: " + clean[i]);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 20 random bytes (160 bits), base32 encoded — RFC 4226 recommended size. */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

function totp(secret, when = Date.now()) {
  const counter = Math.floor(when / 1000 / 30);
  return hotp(secret, counter);
}

/**
 * Constant-time verify against ±`window` 30-second steps to tolerate clock
 * drift. Default window=1 allows one step either side (≈90-second total
 * acceptance window). Pass window=0 for strict verification.
 */
function verify(secret, code, { when = Date.now(), window = 1 } = {}) {
  const clean = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const counter = Math.floor(when / 1000 / 30);
  for (let offset = -window; offset <= window; offset++) {
    const candidate = hotp(secret, counter + offset);
    // timingSafeEqual demands equal-length buffers; both are 6 digits here.
    const a = Buffer.from(candidate, "utf8");
    const b = Buffer.from(clean, "utf8");
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

/**
 * otpauth:// URL for QR generation. `issuer` should be "Garuda Games";
 * `account` is the member's username. Both are URI-encoded.
 */
function otpauthUrl({ issuer, account, secret }) {
  const label = encodeURIComponent(issuer) + ":" + encodeURIComponent(account);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return "otpauth://totp/" + label + "?" + params.toString();
}

module.exports = {
  generateSecret,
  hotp,
  totp,
  verify,
  otpauthUrl,
  base32Encode,
  base32Decode,
};
