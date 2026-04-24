/**
 * Public blader portfolio page. Accepts a `?u=<handle>` query param where
 * `handle` is either a username or an IGN (server matches both). If no
 * param is present and the visitor is signed in, defaults to their own
 * portfolio; otherwise prompts for a handle.
 *
 * Data model (from GET /api/portfolio/:handle):
 *   profile     — display card: ign, squad, clubRole, photo, flags, ...
 *   stats       — lifetime totals + per-game totals
 *   achievements — every verified achievement, newest-first (by event_date)
 *
 * Filtering happens purely client-side against the already-loaded list so
 * the table responds instantly to game/season chip clicks.
 */
(function () {
  if (!window.GarudaApi) return;

  function el(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function formatBladerName(ign) {
    if (
      window.GarudaSite &&
      typeof window.GarudaSite.formatBladerName === "function"
    ) {
      return window.GarudaSite.formatBladerName(ign);
    }
    return ign || "";
  }

  function formatDate(iso) {
    if (!iso) return "—";
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return iso;
    var months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec"
    ];
    var mo = parseInt(m[2], 10) - 1;
    return months[mo] + " " + parseInt(m[3], 10) + ", " + m[1];
  }

  function formatMemberSince(ms) {
    if (!ms) return "";
    var d = new Date(ms);
    if (isNaN(d.getTime())) return "";
    return (
      "Member since " +
      d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "long"
      })
    );
  }

  function clubRoleClass(role) {
    var r = String(role || "Member").toLowerCase();
    if (r.indexOf("founder") !== -1) return "portfolio-flag--founder";
    if (r.indexOf("head") !== -1) return "portfolio-flag--head";
    if (r.indexOf("captain") !== -1 && r.indexOf("vice") !== -1)
      return "portfolio-flag--vice";
    if (r.indexOf("captain") !== -1) return "portfolio-flag--captain";
    return "portfolio-flag--member";
  }

  function gameClass(game) {
    var g = String(game || "").toLowerCase();
    if (g.indexOf("beyblade") !== -1) return "tag-bladers";
    if (g.indexOf("duty") !== -1) return "tag-codm";
    if (g.indexOf("dota") !== -1) return "tag-dota";
    if (g.indexOf("honor") !== -1) return "tag-hok";
    if (g.indexOf("mobile legends") !== -1) return "tag-ml";
    if (g.indexOf("tekken") !== -1) return "tag-tekken";
    if (g.indexOf("valorant") !== -1) return "tag-valorant";
    return "tag-generic";
  }

  var statusEl = el("portfolio-status");
  var contentEl = el("portfolio-content");
  var tbody = el("portfolio-tbody");
  var emptyNote = el("portfolio-empty");
  var gameChips = el("portfolio-game-chips");
  var seasonChips = el("portfolio-season-chips");
  var searchForm = el("portfolio-search");
  var searchInput = el("portfolio-query");

  var loaded = null; // full payload from the server
  var gameFilter = "all";
  var seasonFilter = "all";

  function setStatus(text) {
    if (!statusEl) return;
    statusEl.textContent = text || "";
  }

  function currentHandle() {
    var params = new URLSearchParams(window.location.search);
    return (
      params.get("u") ||
      params.get("username") ||
      params.get("ign") ||
      ""
    ).trim();
  }

  function setHandleInUrl(handle) {
    var url = new URL(window.location.href);
    if (handle) {
      url.searchParams.set("u", handle);
    } else {
      url.searchParams.delete("u");
    }
    window.history.replaceState(null, "", url);
  }

  function loadPortfolio(handle) {
    if (!handle) return;
    setStatus("Loading " + handle + "'s portfolio…");
    if (contentEl) contentEl.hidden = true;
    window.GarudaApi
      .getPortfolio(handle)
      .then(function (data) {
        loaded = data;
        setStatus("");
        render();
      })
      .catch(function (err) {
        loaded = null;
        if (contentEl) contentEl.hidden = true;
        var msg =
          (err && err.status === 404) || /not found/i.test((err && err.message) || "")
            ? 'No blader found for "' + handle + '". Check the spelling or try an IGN.'
            : (err && err.message) || "Could not load portfolio.";
        setStatus(msg);
      });
  }

  function render() {
    if (!loaded) return;
    if (contentEl) contentEl.hidden = false;
    renderProfile(loaded.profile);
    renderStats(loaded.stats);
    renderPerGame(loaded.stats && loaded.stats.perGame);
    renderFilters(loaded.achievements || []);
    renderTable();
    document.title =
      formatBladerName(loaded.profile.ign) + " — Portfolio — Garuda Games";
    setHandleInUrl(loaded.profile.username);
  }

  function renderProfile(p) {
    if (!p) return;
    var photo = el("portfolio-photo");
    if (photo) photo.src = p.photoUrl || p.photoDataUrl || "images/Garuda Logo.jpg";
    var name = el("portfolio-heading");
    if (name) name.textContent = formatBladerName(p.ign);
    var squad = el("portfolio-squad");
    if (squad) squad.textContent = p.squad || "No squad assigned";
    var games = el("portfolio-games");
    if (games) {
      games.textContent =
        p.games && p.games.length ? "Games: " + p.games.join(" · ") : "";
    }
    var since = el("portfolio-since");
    if (since) since.textContent = formatMemberSince(p.memberSince);

    var badges = el("portfolio-badges");
    if (badges) {
      badges.innerHTML = "";
      var clubFlag = document.createElement("span");
      clubFlag.className =
        "portfolio-flag " + clubRoleClass(p.clubRole || "Member");
      clubFlag.textContent = p.clubRole || "Member";
      clubFlag.title = "Club role";
      badges.appendChild(clubFlag);
      if (p.certifiedJudge) {
        var cj = document.createElement("span");
        cj.className = "portfolio-flag portfolio-flag--judge";
        cj.textContent = "Certified Judge";
        badges.appendChild(cj);
      }
      var proGames =
        (window.ProFlags && window.ProFlags.normalize(p.proGames)) ||
        (p.professionalBlader ? ["Beyblade X"] : []);
      if (proGames.length && window.ProFlags) {
        var wrap = document.createElement("span");
        wrap.className = "portfolio-flag-group";
        wrap.innerHTML = window.ProFlags.pillsHtml(proGames, "portfolio-flag");
        Array.prototype.slice.call(wrap.children).forEach(function (n) {
          badges.appendChild(n);
        });
      } else if (p.professionalBlader) {
        var pb = document.createElement("span");
        pb.className = "portfolio-flag portfolio-flag--pro";
        pb.textContent = "Professional Blader";
        badges.appendChild(pb);
      }
    }
  }

  function renderStats(s) {
    if (!s) return;
    var mapping = {
      "portfolio-active-points": s.activeSeasonPoints,
      "portfolio-points": s.lifetimePoints,
      "portfolio-events": s.totalEvents,
      "portfolio-champs": s.championships,
      "portfolio-podiums": s.podiums
    };
    Object.keys(mapping).forEach(function (id) {
      var n = el(id);
      if (n) n.textContent = String(mapping[id] || 0);
    });
    var seasonMeta = el("portfolio-active-season");
    if (seasonMeta) {
      seasonMeta.textContent = s.activeSeason
        ? " · " + s.activeSeason.label
        : "";
    }
  }

  function renderPerGame(rows) {
    var host = el("portfolio-pergame");
    if (!host) return;
    host.innerHTML = "";
    if (!rows || !rows.length) return;
    rows.forEach(function (r) {
      var card = document.createElement("div");
      card.className = "portfolio-pergame__card";
      card.innerHTML =
        '<span class="portfolio-pergame__game ' +
        gameClass(r.game) +
        '">' +
        escapeHtml(r.game) +
        "</span>" +
        '<span class="portfolio-pergame__points">' +
        r.points +
        " pts</span>" +
        '<span class="portfolio-pergame__events">' +
        r.events +
        " event" +
        (r.events === 1 ? "" : "s") +
        "</span>";
      host.appendChild(card);
    });
  }

  function renderFilters(items) {
    // Game chips — derived from the achievements actually in the portfolio so
    // we don't offer a filter that would always return empty.
    if (gameChips) {
      var games = {};
      items.forEach(function (it) {
        games[it.game || "Beyblade X"] = true;
      });
      var gameList = Object.keys(games).sort();
      gameChips.innerHTML = "";
      gameChips.appendChild(
        buildChip("game", "all", "All games", gameFilter === "all")
      );
      gameList.forEach(function (g) {
        gameChips.appendChild(buildChip("game", g, g, gameFilter === g));
      });
    }

    if (seasonChips) {
      var seasons = {};
      items.forEach(function (it) {
        if (it.season) seasons[it.season] = true;
      });
      var seasonList = Object.keys(seasons).sort().reverse();
      seasonChips.innerHTML = "";
      seasonChips.appendChild(
        buildChip("season", "all", "All seasons", seasonFilter === "all")
      );
      seasonList.forEach(function (s) {
        seasonChips.appendChild(
          buildChip("season", s, s, seasonFilter === s)
        );
      });
    }
  }

  function buildChip(kind, value, label, active) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip" + (active ? " chip--active" : "");
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", active ? "true" : "false");
    btn.dataset[kind] = value;
    btn.textContent = label;
    btn.addEventListener("click", function () {
      if (kind === "game") gameFilter = value;
      else if (kind === "season") seasonFilter = value;
      renderFilters(loaded ? loaded.achievements || [] : []);
      renderTable();
    });
    return btn;
  }

  function renderTable() {
    if (!tbody) return;
    var items = (loaded && loaded.achievements) || [];
    var filtered = items.filter(function (it) {
      if (gameFilter !== "all" && it.game !== gameFilter) return false;
      if (seasonFilter !== "all" && it.season !== seasonFilter) return false;
      return true;
    });
    tbody.innerHTML = "";
    if (!filtered.length) {
      if (emptyNote) emptyNote.hidden = false;
      return;
    }
    if (emptyNote) emptyNote.hidden = true;
    filtered.forEach(function (it) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" +
        escapeHtml(formatDate(it.eventDate)) +
        "</td><td>" +
        escapeHtml(it.eventName) +
        (it.isGrandTournament
          ? ' <span class="portfolio-gt">GT</span>'
          : "") +
        (it.countsTowardRanking === false
          ? ' <span class="portfolio-nonscoring" title="' +
            escapeHtml(it.nonScoringReason || "Does not count toward leaderboard.") +
            '">Non-scoring</span>'
          : "") +
        (it.placementVerified
          ? ' <span class="pill--challonge pill--challonge-placement" title="Server matched this placement against the Challonge participant list' +
            (it.verifiedIgn ? " (as " + escapeHtml(it.verifiedIgn) + ")" : "") +
            '.">Challonge &#10003;</span>'
          : it.source === "challonge"
          ? ' <span class="pill--challonge" title="Tournament data was auto-fetched from Challonge at submission time.">Challonge</span>'
          : "") +
        '</td><td><span class="portfolio-gametag ' +
        gameClass(it.game) +
        '">' +
        escapeHtml(it.game) +
        "</span></td><td>" +
        escapeHtml(it.rank) +
        "</td><td>" +
        (it.playerCount || "—") +
        '</td><td class="portfolio-points-cell">' +
        (it.rankPoints || 0) +
        "</td><td>" +
        escapeHtml(it.season || "—") +
        '</td><td class="portfolio-bracket-cell"></td>';
      var bracketCell = tr.querySelector(".portfolio-bracket-cell");
      if (it.challongeUrl) {
        var a = document.createElement("a");
        a.href = it.challongeUrl;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = "Challonge";
        bracketCell.appendChild(a);
      } else {
        bracketCell.textContent = "—";
      }
      tbody.appendChild(tr);
    });
  }

  function init() {
    if (searchForm) {
      searchForm.addEventListener("submit", function (e) {
        e.preventDefault();
        var v = (searchInput && searchInput.value) || "";
        v = v.trim();
        if (!v) return;
        loadPortfolio(v);
      });
    }

    var handle = currentHandle();
    if (handle) {
      if (searchInput) searchInput.value = handle;
      loadPortfolio(handle);
      return;
    }

    // No handle in URL — if the visitor is signed in, show their own
    // portfolio by default; otherwise prompt.
    if (window.GarudaAuth && window.GarudaAuth.ready) {
      window.GarudaAuth.ready().then(function (user) {
        if (user && user.username) {
          if (searchInput) searchInput.value = user.ign || user.username;
          loadPortfolio(user.username);
        } else {
          setStatus(
            "Enter an IGN or username above to view a blader's career record."
          );
        }
      });
    } else {
      setStatus(
        "Enter an IGN or username above to view a blader's career record."
      );
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
