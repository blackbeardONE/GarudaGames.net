/**
 * Shared PRO-flag helpers. A member can carry a Professional tag for any
 * number of supported games (Beyblade X, Tekken, Mobile Legends, etc.), so
 * both the admin forms and the public pills read from the same catalogue.
 *
 * The canonical storage is `proGames: string[]` (e.g. ["Beyblade X", "Tekken"]).
 * This file keeps the game catalogue, short labels for the pills, and a few
 * tiny utilities so every screen renders PRO flags the same way.
 */
(function () {
  // Canonical list of games that can carry a PRO flag. Order matters: it's
  // the order used by the dashboard/admin checkbox list. Keep this in sync
  // with the server's `normalizeProGames` allow-list.
  var CATALOG = [
    { name: "Beyblade X", short: "Beyblade X", cls: "pro-bbx" },
    { name: "Tekken", short: "Tekken", cls: "pro-tekken" },
    { name: "Mobile Legends", short: "ML", cls: "pro-ml" },
    { name: "Honor of Kings", short: "HOK", cls: "pro-hok" },
    { name: "Call of Duty: Mobile", short: "CODM", cls: "pro-codm" },
    { name: "Valorant", short: "Valorant", cls: "pro-valorant" },
    { name: "Dota 2", short: "Dota 2", cls: "pro-dota2" },
  ];

  var BY_NAME = CATALOG.reduce(function (acc, g) {
    acc[g.name.toLowerCase()] = g;
    return acc;
  }, {});

  // Accept a few legacy/fuzzy aliases so admins who type "ML" or "COD Mobile"
  // still end up storing the canonical catalogue name.
  var ALIASES = {
    "beyblade": "Beyblade X",
    "beyblade x": "Beyblade X",
    "bbx": "Beyblade X",
    "tekken": "Tekken",
    "tekken 8": "Tekken",
    "mobile legends": "Mobile Legends",
    "ml": "Mobile Legends",
    "mlbb": "Mobile Legends",
    "honor of kings": "Honor of Kings",
    "hok": "Honor of Kings",
    "call of duty mobile": "Call of Duty: Mobile",
    "call of duty: mobile": "Call of Duty: Mobile",
    "cod mobile": "Call of Duty: Mobile",
    "codm": "Call of Duty: Mobile",
    "valorant": "Valorant",
    "dota 2": "Dota 2",
    "dota2": "Dota 2",
    "dota": "Dota 2",
  };

  function canonical(name) {
    if (typeof name !== "string") return null;
    var k = name.trim().toLowerCase();
    if (!k) return null;
    if (ALIASES[k]) return ALIASES[k];
    if (BY_NAME[k]) return BY_NAME[k].name;
    return null;
  }

  function normalizeList(input) {
    if (!Array.isArray(input)) return [];
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < input.length; i++) {
      var c = canonical(input[i]);
      if (c && !seen[c]) {
        seen[c] = true;
        out.push(c);
      }
    }
    // Preserve catalogue order so the pills always read the same way.
    out.sort(function (a, b) {
      return CATALOG.findIndex(function (g) { return g.name === a; }) -
             CATALOG.findIndex(function (g) { return g.name === b; });
    });
    return out;
  }

  function shortLabel(name) {
    var entry = BY_NAME[String(name || "").toLowerCase()];
    return entry ? entry.short : String(name || "");
  }

  function labelFor(name) {
    return "PRO " + shortLabel(name).toUpperCase();
  }

  function modifierFor(name) {
    var entry = BY_NAME[String(name || "").toLowerCase()];
    return entry ? entry.cls : "pro-generic";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Build a chunk of HTML with one pill per game. `baseClass` is the
  // design-system prefix (e.g. "lb-badge", "portfolio-flag", "verify-flag")
  // so each surface keeps its existing look; the `--pro` and game-specific
  // modifier (`--pro-tekken`) classes are appended on top.
  function pillsHtml(games, baseClass) {
    var list = normalizeList(games);
    if (!list.length) return "";
    var base = String(baseClass || "").trim();
    return list
      .map(function (name) {
        var mod = modifierFor(name);
        var cls = [
          base,
          base ? base + "--pro" : "",
          base ? base + "--" + mod : mod,
        ]
          .filter(Boolean)
          .join(" ");
        return '<span class="' + escapeHtml(cls) +
               '">' + escapeHtml(labelFor(name)) + '</span>';
      })
      .join(" ");
  }

  window.ProFlags = {
    catalog: CATALOG.slice(),
    names: function () { return CATALOG.map(function (g) { return g.name; }); },
    normalize: normalizeList,
    canonical: canonical,
    shortLabel: shortLabel,
    label: labelFor,
    modifier: modifierFor,
    pillsHtml: pillsHtml,
  };
})();
