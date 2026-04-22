# Garuda Games

The source-available website, membership portal, and submission/verification
pipeline for **Garuda Games** — the competitive Gear Sports and E-Sports
club.

Live at **[garudagames.net](https://garudagames.net)**.

> **This repository is source-available, NOT open-source.**
> Reading is fine; running, forking-to-deploy, and any kind of monetary
> use are **not** permitted without a signed commercial license from
> Garuda Games. See [`LICENSE`](./LICENSE) for the full terms.

---

## What this is

A single-tenant, self-hosted web application that runs the club. It is
deliberately small and boring — one Node.js process, one SQLite file,
one nginx — so a small admin team can keep it alive.

Member-facing features:

- Public landing page, leaderboard, member directory, and news.
- Sign-up and sign-in with scrypt-hashed passwords, per-user lockout,
  rate limiting, and optional TOTP two-factor authentication.
- A member dashboard for managing profile, squads, games, and
  submissions.
- Achievement submission with staff verification workflow; verified
  achievements contribute to a season-based leaderboard.
- Certified-Judge / Pro-Blader identity flags with staff review.
- News page with categories, pinned posts, and an Atom feed for
  subscribers.
- Forgot-password flow backed by admin-issued single-use reset tokens.

Staff-facing features:

- Admin console for members, roles, club roles, squads, and news
  authoring.
- Verifier queue for achievements and identity flags.
- Audit log viewer.
- CSV exports for members, audit, and achievements.

## Tech stack

| Layer         | Choice                                       |
|---------------|----------------------------------------------|
| Language      | JavaScript (Node.js, plain browser JS)       |
| HTTP          | Express                                      |
| DB            | SQLite via `better-sqlite3`                  |
| Schema        | Migrations in `server/migrations/NNNN_*.js`  |
| Auth          | Cookie sessions, scrypt hashing, RFC-6238 TOTP |
| Assets        | Static HTML/CSS/JS — no build step           |
| Front door    | nginx (TLS + reverse proxy)                  |

No frameworks, no bundlers, no transpilers. Drop the repo on a box
with Node, `npm install`, run.

## Repo layout

```
├── *.html                       public + authenticated pages
├── css/                         styles
├── js/                          browser-side logic
├── images/                      brand + game assets
└── server/
    ├── index.js                 the whole API
    ├── db.js                    SQLite bootstrap + base schema
    ├── migrations.js            idempotent migration runner
    ├── migrations/              NNNN_*.js migrations
    ├── totp.js                  RFC-6238 TOTP + RFC-4648 base32
    ├── package.json
    └── package-lock.json
```

## Why publish it at all?

Three reasons:

1. **Transparency for members.** Anyone at the club can see exactly how
   their account, achievements, and points are handled. No black box.
2. **Security review.** Inviting people to read the source makes it
   more likely that a real bug is caught by a real pair of eyes
   before a real attacker finds it.
3. **Portfolio.** The project is part of the public record of what the
   club has built.

## What you may NOT do (short version)

You may **not**, without written permission from Garuda Games:

- deploy this code, or anything derived from it, on any server —
  personal, club, or commercial;
- fork-and-rebrand this code as your own site;
- use this code in any for-profit product, service, or venture;
- sell, resell, sublicense, or redistribute this code;
- train or fine-tune models on this code for commercial use.

See [`LICENSE`](./LICENSE) for the authoritative terms.

## Commercial licensing

If you want to run this, adapt it, or build a commercial offering on
top of it, we're open to that — but it needs a signed agreement.
Contact the Garuda Games team via the official project site at
[garudagames.net](https://garudagames.net) or via the GitHub account
that publishes this repository.

## Security disclosure

Please do not open a public issue for a security problem. Contact
the Garuda Games admin team privately via the channels listed on the
official site. We will acknowledge within a reasonable time and
credit reporters who ask to be credited.

## Attribution

All code, assets, and documentation in this repository are © 2026
Garuda Games, except where a separate notice indicates third-party
authorship. Trademark references (including game titles such as
*Beyblade X*, *Call of Duty: Mobile*, *Dota 2*, *Honor of Kings*,
*Mobile Legends*, *Tekken*, and *Valorant*) are the property of
their respective owners and used here only to identify the games
our members compete in.
