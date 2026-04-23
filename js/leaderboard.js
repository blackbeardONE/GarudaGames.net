(function () {
  if (!window.GarudaApi) return;

  var tbody = document.getElementById("lb-tbody");
  var emptyNote = document.getElementById("lb-empty");
  var topCards = document.getElementById("lb-top-cards");
  var search = document.getElementById("lb-search");
  var squadChips = document.getElementById("lb-squad-chips");
  var gameChips = document.getElementById("lb-game-chips");
  var seasonSelect = document.getElementById("lb-season");

  var FALLBACK_GAMES = [
    "Beyblade X",
    "Call of Duty: Mobile",
    "Dota 2",
    "Honor of Kings",
    "Mobile Legends",
    "Tekken",
    "Valorant",
  ];

  // Canonical squad roster — kept in sync with the signup dropdown so every
  // squad gets a filter chip even before any of its members earn points.
  var ALL_SQUADS = [
    "Garuda Dark Phoenix",
    "Garuda Esports",
    "Garuda Guardian",
    "Garuda Harpy",
    "Garuda Macaw",
    "Garuda Tengu",
    "Garuda Vortex",
  ];

  var rows = [];
  var squadFilter = "";
  var query = "";
  var gameFilter = "all";
  var seasonFilter = "all";
  var squadChipsBuilt = false;

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function formatBladerName(ign) {
    if (window.GarudaSite && typeof window.GarudaSite.formatBladerName === "function") {
      return window.GarudaSite.formatBladerName(ign);
    }
    var name = String(ign == null ? "" : ign).trim();
    if (!name) return "";
    return "GRD|TAS " + name;
  }

  function matches(r) {
    if (squadFilter && r.squad !== squadFilter) return false;
    if (!query) return true;
    var q = query.toLowerCase();
    // Also match against the tagged display name so searches for e.g.
    // "GRD|TAS" or "grd|tas name" still find the right blader.
    return (
      (r.ign || "").toLowerCase().indexOf(q) !== -1 ||
      formatBladerName(r.ign).toLowerCase().indexOf(q) !== -1 ||
      (r.squad || "").toLowerCase().indexOf(q) !== -1
    );
  }

  function badgeHtml(r) {
    var tags = [];
    var clubFlag = clubRoleFlagHtml(r.clubRole);
    if (clubFlag) tags.push(clubFlag);
    if (r.certifiedJudge) tags.push('<span class="lb-badge">Judge</span>');
    var proGames =
      (window.ProFlags && window.ProFlags.normalize(r.proGames)) ||
      (r.professionalBlader ? ["Beyblade X"] : []);
    if (proGames.length && window.ProFlags) {
      tags.push(window.ProFlags.pillsHtml(proGames, "lb-badge"));
    } else if (r.professionalBlader) {
      tags.push('<span class="lb-badge lb-badge--pro">Pro Blader</span>');
    }
    return tags.join(" ");
  }

  // Render a Founder / Captain-tier / Vice Captain flag next to the name.
  // We deliberately skip plain Members here — the leaderboard would
  // otherwise get a pill on every single row for no information gain.
  // Legacy free-form values
  // (e.g. "Head Captain") still resolve via substring match.
  function clubRoleFlagHtml(cr) {
    var s = String(cr || "").trim();
    var low = s.toLowerCase();
    var cls = null;
    if (low.indexOf("founder") !== -1) cls = "lb-badge--founder";
    else if (low.indexOf("vice") !== -1) cls = "lb-badge--vice";
    else if (low.indexOf("captain") !== -1) cls = "lb-badge--captain";
    if (!cls) return "";
    return '<span class="lb-badge ' + cls + '">' + escapeHtml(s) + "</span>";
  }

  function renderTop(filtered) {
    if (!topCards) return;
    var top = filtered.slice(0, 3);
    if (!top.length) {
      topCards.innerHTML = "";
      return;
    }
    var html = top
      .map(function (r) {
        var photo = r.photoDataUrl || "images/Garuda Logo.jpg";
        var badge =
          r.rank === 1
            ? "Champion"
            : r.rank === 2
              ? "Runner-up"
              : r.rank === 3
                ? "Third"
                : "#" + r.rank;
        var portfolioHref =
          "portfolio.html?u=" + encodeURIComponent(r.username || r.ign || "");
        return (
          '<article class="lb-top-card lb-top-card--' +
          Math.min(r.rank, 3) +
          '">' +
          '<div class="lb-top-card__rank">' +
          escapeHtml(badge) +
          "</div>" +
          '<a class="lb-top-card__link" href="' +
          escapeHtml(portfolioHref) +
          '">' +
          '<img class="lb-top-card__photo" src="' +
          escapeHtml(photo) +
          '" alt="' +
          escapeHtml(formatBladerName(r.ign)) +
          '" />' +
          '<div class="lb-top-card__meta">' +
          '<h3 class="lb-top-card__name">' +
          escapeHtml(formatBladerName(r.ign)) +
          "</h3>" +
          '<p class="lb-top-card__squad">' +
          escapeHtml(r.squad || "—") +
          "</p>" +
          '<p class="lb-top-card__points">' +
          r.points +
          " pts · " +
          r.wins +
          " verified result" +
          (r.wins === 1 ? "" : "s") +
          "</p>" +
          '<p class="lb-top-card__badges">' +
          badgeHtml(r) +
          "</p>" +
          "</div></a></article>"
        );
      })
      .join("");
    topCards.innerHTML = html;
  }

  function renderTable(filtered) {
    if (!tbody) return;
    tbody.innerHTML = "";
    if (!filtered.length) {
      if (emptyNote) {
        emptyNote.hidden = false;
        emptyNote.textContent =
          gameFilter !== "all" || seasonFilter !== "all"
            ? "No verified results match the current filters yet."
            : "No verified results yet. Earn points by finishing on the podium in an officiated tournament.";
      }
      return;
    }
    if (emptyNote) emptyNote.hidden = true;
    var html = filtered
      .map(function (r) {
        var portfolioHref =
          "portfolio.html?u=" + encodeURIComponent(r.username || r.ign || "");
        return (
          "<tr>" +
          '<td class="lb-rank">#' +
          r.rank +
          "</td>" +
          "<td>" +
          '<a class="lb-member lb-member__link" href="' +
          escapeHtml(portfolioHref) +
          '">' +
          '<img class="lb-member__photo" src="' +
          escapeHtml(r.photoDataUrl || "images/Garuda Logo.jpg") +
          '" alt="" />' +
          '<span class="lb-member__meta">' +
          '<span class="lb-member__ign">' +
          escapeHtml(formatBladerName(r.ign)) +
          "</span> " +
          badgeHtml(r) +
          '<span class="lb-member__games">' +
          escapeHtml((r.games || []).join(" · ")) +
          "</span>" +
          "</span></a></td>" +
          "<td>" +
          escapeHtml(r.squad || "—") +
          "</td>" +
          "<td>" +
          r.wins +
          "</td>" +
          '<td class="lb-points">' +
          r.points +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
    tbody.innerHTML = html;
  }

  function rerender() {
    var filtered = rows.filter(matches);
    renderTop(filtered);
    renderTable(filtered);
  }

  function buildSquadChips() {
    if (!squadChips || squadChipsBuilt) return;
    squadChipsBuilt = true;

    // Always show the canonical 6 squads so the filter is complete even when
    // no one from a given squad has earned points yet. Extra squads discovered
    // in the data (legacy or custom names) are appended after the canonical
    // list so they remain selectable.
    var canonical = ALL_SQUADS.slice();
    var seen = {};
    canonical.forEach(function (s) {
      seen[s] = true;
    });
    var extra = [];
    rows.forEach(function (r) {
      if (r.squad && !seen[r.squad]) {
        seen[r.squad] = true;
        extra.push(r.squad);
      }
    });
    extra.sort();
    var allSquads = canonical.concat(extra);

    allSquads.forEach(function (name) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.dataset.squad = name;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", "false");
      btn.textContent = name;
      squadChips.appendChild(btn);
    });

    squadChips.addEventListener("click", function (e) {
      var t = e.target;
      if (!t || t.tagName !== "BUTTON") return;
      activateChip(squadChips, t);
      squadFilter = t.dataset.squad || "";
      rerender();
    });
  }

  function buildGameChips(games) {
    if (!gameChips) return;
    gameChips.innerHTML = "";
    var allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "chip chip--active";
    allBtn.dataset.game = "all";
    allBtn.setAttribute("role", "tab");
    allBtn.setAttribute("aria-selected", "true");
    allBtn.textContent = "All games";
    gameChips.appendChild(allBtn);
    (games || FALLBACK_GAMES).forEach(function (name) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.dataset.game = name;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", "false");
      btn.textContent = name;
      gameChips.appendChild(btn);
    });
    gameChips.addEventListener("click", function (e) {
      var t = e.target;
      if (!t || t.tagName !== "BUTTON") return;
      activateChip(gameChips, t);
      var next = t.dataset.game || "all";
      if (next === gameFilter) return;
      gameFilter = next;
      loadLeaderboard();
    });
  }

  function activateChip(root, selected) {
    var all = root.querySelectorAll("button");
    for (var i = 0; i < all.length; i++) {
      all[i].classList.remove("chip--active");
      all[i].setAttribute("aria-selected", "false");
    }
    selected.classList.add("chip--active");
    selected.setAttribute("aria-selected", "true");
  }

  function buildSeasonOptions() {
    if (!seasonSelect) return;
    var now = new Date();
    var monthNames = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    // Four 3-month ranking seasons per calendar year:
    //   S1 = January–March, S2 = April–June,
    //   S3 = July–September, S4 = October–December.
    function seasonNumFromMonth(m0) {
      return Math.floor(m0 / 3) + 1; // m0 is 0-indexed month, yields 1..4
    }
    function seasonLabel(y, s) {
      var startIdx = (s - 1) * 3; // 0, 3, 6, 9
      var endIdx = startIdx + 2; // inclusive last month of the season
      return (
        "Season " +
        s +
        " · " +
        monthNames[startIdx] +
        " to " +
        monthNames[endIdx] +
        " " +
        y
      );
    }

    seasonSelect.innerHTML = "";
    var optAll = document.createElement("option");
    optAll.value = "all";
    optAll.textContent = "All time";
    seasonSelect.appendChild(optAll);

    // Ranking starts in 2026 — earlier years had no verified data, so they'd
    // only show empty leaderboards. List every season from 2026 up to the
    // current one in chronological order.
    var INAUGURAL_YEAR = 2026;
    var curY = now.getUTCFullYear();
    var curS = seasonNumFromMonth(now.getUTCMonth());
    if (curY < INAUGURAL_YEAR) {
      // Before 2026 the site still works, but only the inaugural season is
      // meaningful to offer.
      curY = INAUGURAL_YEAR;
      curS = 1;
    }
    for (var yy = INAUGURAL_YEAR; yy <= curY; yy++) {
      var lastS = yy === curY ? curS : 4;
      for (var ss = 1; ss <= lastS; ss++) {
        var opt = document.createElement("option");
        opt.value = yy + "-S" + ss;
        opt.textContent =
          seasonLabel(yy, ss) +
          (yy === curY && ss === curS ? " (current)" : "");
        seasonSelect.appendChild(opt);
      }
    }

    // Monthly drill-down: the 12 months of the current ranking year in
    // calendar order (January → December) so captains can scan the timeline
    // the same way they read a season schedule.
    var sepCur = document.createElement("option");
    sepCur.disabled = true;
    sepCur.textContent = "──────── " + curY + " · monthly ────────";
    seasonSelect.appendChild(sepCur);
    for (var mIdx = 0; mIdx < 12; mIdx++) {
      var mmCur = mIdx + 1;
      var moCur = document.createElement("option");
      moCur.value = curY + "-" + (mmCur < 10 ? "0" : "") + mmCur;
      moCur.textContent = monthNames[mIdx] + " " + curY;
      seasonSelect.appendChild(moCur);
    }

    seasonSelect.addEventListener("change", function () {
      seasonFilter = seasonSelect.value || "all";
      loadLeaderboard();
    });
  }

  function loadLeaderboard() {
    if (emptyNote) {
      emptyNote.hidden = true;
    }
    return window.GarudaApi
      .leaderboard({ game: gameFilter, season: seasonFilter })
      .then(function (res) {
        rows = (res && res.leaderboard) || [];
        if (!squadChipsBuilt) buildSquadChips();
        if (gameChips && gameChips.children.length <= 1) {
          buildGameChips((res && res.availableGames) || FALLBACK_GAMES);
        }
        rerender();
      })
      .catch(function (err) {
        console.error(err);
        if (emptyNote) {
          emptyNote.textContent = "Could not load leaderboard right now.";
          emptyNote.hidden = false;
        }
      });
  }

  if (search) {
    search.addEventListener("input", function () {
      query = search.value.trim();
      rerender();
    });
  }

  buildSeasonOptions();
  buildGameChips(FALLBACK_GAMES);
  buildSquadChips();

  if (window.GarudaAuth && window.GarudaAuth.ready) {
    window.GarudaAuth.ready().then(function (u) {
      var btn = document.getElementById("nav-logout");
      if (btn && u) {
        btn.hidden = false;
        btn.addEventListener("click", function () {
          window.GarudaAuth.logout();
        });
      }
    });
  }

  loadLeaderboard();
})();

// v1.16.0: Verifier leaderboard. Kept as a separate IIFE so it can mount
// or no-op independently of the main leaderboard — the section is only
// on leaderboard.html but the same JS file may ship on other pages in
// the future, and the two tables don't share filters/state.
(function () {
  if (!window.GarudaApi) return;
  var tbody = document.getElementById("vlb-tbody");
  if (!tbody) return;
  var emptyNote = document.getElementById("vlb-empty");
  var chipsHost = document.querySelector(".verifier-leaderboard__chips");
  var chips = chipsHost ? chipsHost.querySelectorAll("[data-vlb-window]") : [];
  var currentWindow = "90d";

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function roleBadge(role) {
    var label = role === "admin" ? "Admin" : role === "verifier" ? "Verifier" : "Member";
    var klass = role === "admin"
      ? "verifier-leaderboard__role verifier-leaderboard__role--admin"
      : role === "verifier"
      ? "verifier-leaderboard__role verifier-leaderboard__role--verifier"
      : "verifier-leaderboard__role";
    return '<span class="' + klass + '">' + label + "</span>";
  }

  function humanAgo(ts) {
    if (!ts) return "—";
    var diff = Date.now() - Number(ts);
    if (!(diff >= 0)) return "—";
    var day = 24 * 60 * 60 * 1000;
    if (diff < day) return "today";
    if (diff < 2 * day) return "yesterday";
    if (diff < 14 * day) return Math.floor(diff / day) + " days ago";
    if (diff < 60 * day) return Math.floor(diff / (7 * day)) + " weeks ago";
    return Math.floor(diff / (30 * day)) + " months ago";
  }

  function render(rows) {
    if (!rows.length) {
      tbody.innerHTML = "";
      if (emptyNote) emptyNote.hidden = false;
      return;
    }
    if (emptyNote) emptyNote.hidden = true;
    var html = "";
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      html +=
        "<tr>" +
        '<td class="verifier-leaderboard__rank">' + r.rank + "</td>" +
        '<td class="verifier-leaderboard__member">' +
          '<span class="verifier-leaderboard__ign">' + escapeHtml(r.ign) + "</span>" +
          '<span class="verifier-leaderboard__username">@' + escapeHtml(r.username) + "</span>" +
        "</td>" +
        "<td>" + roleBadge(r.role) + "</td>" +
        '<td class="verifier-leaderboard__count">' + Number(r.verifiedCount || 0).toLocaleString() + "</td>" +
        "<td>" + escapeHtml(humanAgo(r.lastVerifiedAt)) + "</td>" +
        "</tr>";
    }
    tbody.innerHTML = html;
  }

  function load(win) {
    currentWindow = win === "all" ? "all" : "90d";
    window.GarudaApi
      .verifierLeaderboard({ window: currentWindow })
      .then(function (res) {
        render(((res && res.leaderboard) || []));
      })
      .catch(function (err) {
        console.error(err);
        tbody.innerHTML = "";
        if (emptyNote) {
          emptyNote.textContent = "Could not load verifier leaderboard right now.";
          emptyNote.hidden = false;
        }
      });
  }

  if (chips && chips.length) {
    chips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        chips.forEach(function (c) {
          c.classList.remove("chip--active");
          c.setAttribute("aria-selected", "false");
        });
        chip.classList.add("chip--active");
        chip.setAttribute("aria-selected", "true");
        load(chip.getAttribute("data-vlb-window") || "90d");
      });
    });
  }

  load("90d");
})();
