(function () {
  if (!window.GarudaApi) return;

  function normalize(str) {
    return String(str)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  // Prefer the shared site-settings helper so admin-edited club tags win.
  // Fallback keeps the page usable if site-settings.js didn't load yet.
  function formatBladerName(ign) {
    if (window.GarudaSite && typeof window.GarudaSite.formatBladerName === "function") {
      return window.GarudaSite.formatBladerName(ign);
    }
    var name = String(ign == null ? "" : ign).trim();
    if (!name) return "";
    return "GRD|TAS " + name;
  }

  function gameClass(game) {
    if (game.indexOf("Beyblade") !== -1) return "verify-tag--beyblade";
    if (game.indexOf("Call of Duty") !== -1) return "verify-tag--codm";
    if (game.indexOf("Mobile") !== -1) return "verify-tag--mlbb";
    if (game.indexOf("Honor") !== -1) return "verify-tag--hok";
    if (game.indexOf("Dota") !== -1) return "verify-tag--dota";
    if (game.indexOf("Tekken") !== -1) return "verify-tag--tekken";
    if (game.indexOf("Valorant") !== -1) return "verify-tag--valorant";
    return "";
  }

  // Style hook for the club role flag. Captain / Vice Captain get a
  // highlighted pill; plain Members stay muted so the flag never lies
  // about rank. We match legacy free-form strings too — e.g. an older
  // DB row of "Head Captain" or "Squad Captain" should still show as
  // a Captain flag, and "Assistant Vice Captain" as Vice Captain.
  function clubRoleClass(cr) {
    var s = String(cr || "").trim().toLowerCase();
    if (s.indexOf("founder") !== -1) return "verify-flag--founder";
    if (s.indexOf("vice") !== -1) return "verify-flag--vice";
    if (s.indexOf("captain") !== -1) return "verify-flag--captain";
    return "verify-flag--member";
  }

  function renderMatch(container, m) {
    container.innerHTML = "";
    container.className = "verify-outcome verify-outcome--found";

    var card = document.createElement("article");
    card.className = "verify-card";

    var media = document.createElement("div");
    media.className = "verify-card__media";
    var displayIgn = formatBladerName(m.ign);
    var img = document.createElement("img");
    img.className = "verify-card__photo";
    img.src = m.photoDataUrl || "images/Garuda Logo.jpg";
    img.width = 280;
    img.height = 280;
    img.alt =
      "Verified member photo: " +
      (m.realName || displayIgn) +
      ", IGN " +
      displayIgn;
    img.loading = "lazy";
    media.appendChild(img);

    var body = document.createElement("div");
    body.className = "verify-card__body";

    var badgeRow = document.createElement("div");
    badgeRow.className = "verify-card__badge-row";

    var badge = document.createElement("span");
    badge.className = "verify-card__badge";
    badge.textContent = "Verified member";
    badgeRow.appendChild(badge);

    var clubRole = m.clubRole || "Member";
    var clubFlag = document.createElement("span");
    clubFlag.className = "verify-flag " + clubRoleClass(clubRole);
    clubFlag.textContent = clubRole;
    clubFlag.title = "Club role";
    badgeRow.appendChild(clubFlag);

    if (m.certifiedJudge) {
      var judgeFlag = document.createElement("span");
      judgeFlag.className = "verify-flag verify-flag--judge";
      judgeFlag.textContent = "Certified Judge";
      badgeRow.appendChild(judgeFlag);
    }

    var proGames =
      (window.ProFlags && window.ProFlags.normalize(m.proGames)) ||
      (m.professionalBlader ? ["Beyblade X"] : []);
    if (proGames.length && window.ProFlags) {
      var proWrap = document.createElement("span");
      proWrap.innerHTML = window.ProFlags.pillsHtml(proGames, "verify-flag");
      Array.prototype.slice.call(proWrap.children).forEach(function (n) {
        badgeRow.appendChild(n);
      });
    }

    var ignEl = document.createElement("p");
    ignEl.className = "verify-card__ign";
    ignEl.innerHTML =
      '<span class="verify-card__label">IGN</span> ' +
      escapeHtml(displayIgn);

    var nameEl = document.createElement("p");
    nameEl.className = "verify-card__real";
    nameEl.innerHTML =
      '<span class="verify-card__label">Full name</span> ' +
      escapeHtml(m.realName || displayIgn);

    var gamesTitle = document.createElement("h2");
    gamesTitle.className = "verify-card__games-title";
    gamesTitle.textContent = "Games";

    var list = document.createElement("ul");
    list.className = "verify-card__games";
    var games = m.games && m.games.length ? m.games : [];
    for (var g = 0; g < games.length; g++) {
      var li = document.createElement("li");
      var span = document.createElement("span");
      span.className = "verify-tag " + gameClass(games[g]);
      span.textContent = games[g];
      li.appendChild(span);
      list.appendChild(li);
    }

    media.appendChild(badgeRow);
    body.appendChild(ignEl);
    body.appendChild(nameEl);
    body.appendChild(gamesTitle);
    body.appendChild(list);

    // Deep-link to the blader's public career portfolio. We prefer the
    // canonical username (stable, URL-safe) but fall back to the IGN so
    // legacy responses without a username still resolve.
    var handle = m.username || m.ign || "";
    if (handle) {
      var portfolioLink = document.createElement("a");
      portfolioLink.className = "verify-card__portfolio-link";
      portfolioLink.href =
        "portfolio.html?u=" + encodeURIComponent(handle);
      portfolioLink.textContent = "View full portfolio →";
      body.appendChild(portfolioLink);
    }

    card.appendChild(media);
    card.appendChild(body);
    container.appendChild(card);
  }

  function renderNotFound(container, query) {
    container.innerHTML = "";
    container.className = "verify-outcome verify-outcome--miss";
    var p = document.createElement("p");
    p.className = "verify-miss";
    p.textContent =
      "No roster match for that IGN or name. Double-check spelling, or ask the member to register on the Garuda Games site.";
    container.appendChild(p);
    var small = document.createElement("p");
    small.className = "verify-miss-hint";
    small.textContent = "Searched: " + (query.trim() || "(empty)");
    container.appendChild(small);
  }

  var form = document.getElementById("verify-form");
  var input = document.getElementById("verify-query");
  var outcome = document.getElementById("verify-outcome");

  if (!form || !input || !outcome) return;

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var q = input.value;
    if (!normalize(q)) {
      renderNotFound(outcome, q);
      return;
    }
    outcome.className = "verify-outcome";
    outcome.innerHTML =
      '<p class="verify-miss-hint">Searching…</p>';
    window.GarudaApi
      .lookupMember(q)
      .then(function (res) {
        var m = res && res.match;
        if (m) renderMatch(outcome, m);
        else renderNotFound(outcome, q);
      })
      .catch(function (err) {
        outcome.className = "verify-outcome verify-outcome--miss";
        outcome.innerHTML =
          '<p class="verify-miss">' +
          escapeHtml((err && err.message) || "Search failed.") +
          "</p>";
      });
  });
})();
