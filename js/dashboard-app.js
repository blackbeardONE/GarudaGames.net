(function () {
  if (!window.GarudaAuth || !window.GarudaApi || !window.GarudaImageUtils) {
    console.error("Missing Garuda modules");
    return;
  }

  var ALL_GAMES = [
    "Beyblade X",
    "Call of Duty: Mobile",
    "Dota 2",
    "Honor of Kings",
    "Mobile Legends",
    "Tekken",
    "Valorant"
  ];

  var RANK_META = {
    champ: { base: 20, label: "Champion" },
    swiss_king: { base: 10, label: "Swiss King" },
    "2nd": { base: 10, label: "2nd" },
    "3rd": { base: 5, label: "3rd" },
    podium: { base: 2, label: "Podium" }
  };

  // Mirrors eventLooksLikeJlap() on the server: catches "JLAP",
  // "Judge Like a Pro", or "Certified Judge" in any casing/spacing so
  // we can steer members to the correct submission form before they waste
  // a round-trip to the verifier queue.
  function eventLooksLikeJlap(name) {
    var s = String(name == null ? "" : name).toLowerCase();
    if (!s.trim()) return false;
    if (s.indexOf("jlap") !== -1) return true;
    if (/judge\s*like\s*a\s*pro/.test(s)) return true;
    if (/certified\s+judge/.test(s)) return true;
    return false;
  }

  function ordinal(n) {
    var v = n % 100;
    if (v >= 11 && v <= 13) return n + "th";
    switch (n % 10) {
      case 1: return n + "st";
      case 2: return n + "nd";
      case 3: return n + "rd";
      default: return n + "th";
    }
  }

  function computePoints(rankCode, placement, playerCount) {
    var meta = RANK_META[rankCode];
    if (!meta) return 0;
    var base = meta.base;
    if (rankCode === "podium") {
      var p = parseInt(placement, 10) || 0;
      if (p < 4) return 0;
      base = 2;
    }
    var gt = Number(playerCount) >= 64;
    return gt ? base * 2 : base;
  }

  function el(id) {
    return document.getElementById(id);
  }
  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  var user = null;
  var achievements = [];
  var jlap = [];
  var idFlagsState = null;

  window.GarudaAuth
    .requireSessionOrRedirect("dashboard.html")
    .then(function (u) {
      if (!u) return null;
      user = u;
      renderProfile();
      renderDigitalId();
      hydrateProfileForm();
      bindPhotoUpload();
      bindAchievementForm();
      bindJlapForm();
      bindIdMetaForm();
      bindProfileForm();
      bindPasswordForm();
      bindTotp();
      bindInboxBadge();
      bindDigitalIdModal();
      bindLogout();
      return Promise.all([
        refreshAchievements(),
        refreshJlap(),
        refreshIdFlags(),
        refreshInboxBadge()
      ]);
    })
    .then(function () {
      renderSubmissions();
      renderGallery();
    })
    .catch(function (err) {
      console.error(err);
    });

  function refreshAchievements() {
    return window.GarudaApi.listAchievements().then(function (r) {
      achievements = (r && r.achievements) || [];
    });
  }

  function refreshJlap() {
    return window.GarudaApi.listJlap().then(function (r) {
      jlap = (r && r.jlap) || [];
    });
  }

  function refreshIdFlags() {
    return window.GarudaApi.myIdFlags().then(function (r) {
      idFlagsState = r || null;
      refreshIdFlagControls();
    });
  }

  function renderProfile() {
    if (!user) return;
    var photo = user.photoDataUrl || "images/Garuda Logo.jpg";
    var welcome = el("dash-welcome");
    var ignEl = el("dash-ign");
    var nameEl = el("dash-realname");
    var roleEl = el("dash-role");
    var squadEl = el("dash-squad");
    var photoEl = el("dash-photo");
    var gamesEl = el("dash-games");
    var roleBadge = el("dash-app-role");

    var displayIgn = formatBladerName(user.ign);
    if (welcome) {
      welcome.textContent =
        "Welcome back, " + displayIgn + " (" + user.role + ").";
    }
    if (ignEl) ignEl.textContent = displayIgn;
    if (nameEl) nameEl.textContent = user.realName;
    if (roleEl) renderClubRolePill(roleEl, user.clubRole);
    if (squadEl) squadEl.textContent = user.squad;
    if (roleBadge) {
      roleBadge.textContent =
        "Account: " +
        user.role.charAt(0).toUpperCase() +
        user.role.slice(1);
    }
    if (photoEl) {
      photoEl.src = photo;
      photoEl.alt = (user.realName || displayIgn) + " profile photo";
    }
    if (gamesEl && user.games) {
      gamesEl.innerHTML = "";
      for (var i = 0; i < user.games.length; i++) {
        var li = document.createElement("li");
        var span = document.createElement("span");
        span.className = "dash-game-tag";
        span.textContent = user.games[i];
        li.appendChild(span);
        gamesEl.appendChild(li);
      }
    }
    // Dual-banner rendering. `points` is the legacy field kept for backward
    // compatibility; the server also sends activeSeasonPoints/lifetimePoints
    // split apart so the dashboard can show the auto-resetting season
    // counter next to the lifetime career total.
    var activePts = user.activeSeasonPoints;
    if (activePts == null) activePts = user.points || 0;
    var lifetimePts = user.lifetimePoints;
    if (lifetimePts == null) lifetimePts = user.points || 0;

    var ptsEl = el("dash-points-value");
    if (ptsEl) ptsEl.textContent = String(activePts);

    var lifeEl = el("dash-lifetime-value");
    if (lifeEl) lifeEl.textContent = String(lifetimePts);

    var seasonLabelEl = el("dash-season-label");
    if (seasonLabelEl) {
      seasonLabelEl.textContent = user.activeSeason
        ? " · " + user.activeSeason.label
        : "";
    }

    var activeEventsEl = el("dash-active-events");
    if (activeEventsEl) {
      var n = user.activeSeasonEvents || 0;
      activeEventsEl.textContent = n
        ? n + " event" + (n === 1 ? "" : "s") + " this season"
        : "No verified events this season yet";
    }

    var lifeEventsEl = el("dash-lifetime-events");
    if (lifeEventsEl) {
      var ln = user.lifetimeEvents || 0;
      lifeEventsEl.textContent = ln
        ? ln + " verified event" + (ln === 1 ? "" : "s") + " overall"
        : "";
    }

    var portfolioLink = el("dash-portfolio-link");
    if (portfolioLink && user.username) {
      portfolioLink.href =
        "portfolio.html?u=" + encodeURIComponent(user.username);
    }
  }

  function renderDigitalId() {
    if (!user) return;
    var cj = el("id-certified-judge");
    var pg = el("id-professional-games");
    if (cj) cj.textContent = user.certifiedJudge ? "Yes" : "No";
    if (pg) {
      var approved =
        (window.ProFlags && window.ProFlags.normalize(user.proGames)) ||
        (user.professionalBlader ? ["Beyblade X"] : []);
      if (approved.length && window.ProFlags) {
        pg.innerHTML = window.ProFlags.pillsHtml(approved, "digital-id-flag");
      } else {
        pg.textContent = "None";
      }
    }
    var cardPhoto = el("digital-id-photo");
    if (cardPhoto)
      cardPhoto.src = user.photoDataUrl || "images/Garuda Logo.jpg";
    var ign = el("digital-id-ign");
    var nm = el("digital-id-name");
    var sq = el("digital-id-squad");
    var cr = el("digital-id-clubrole");
    if (ign) ign.textContent = formatBladerName(user.ign);
    if (nm) nm.textContent = user.realName;
    if (sq) sq.textContent = user.squad;
    // Surface the club role on the Digital ID for every member. Captains
    // and Vice Captains get a highlighted pill; plain Members get the
    // muted variant so the ID still reads as an official card rather
    // than a blank space.
    if (cr) {
      cr.innerHTML = "";
      cr.hidden = false;
      cr.appendChild(buildClubRolePill(user.clubRole || "Member"));
    }
  }

  // Prepends the admin-managed club tag (default GRD|TAS) to an IGN so
  // every blader name on the dashboard renders as "<tag> <ign>". We use
  // the shared site-settings helper so an admin-edited tag propagates
  // without another round of page changes.
  function formatBladerName(ign) {
    if (window.GarudaSite && typeof window.GarudaSite.formatBladerName === "function") {
      return window.GarudaSite.formatBladerName(ign);
    }
    var name = String(ign == null ? "" : ign).trim();
    if (!name) return "";
    return "GRD|TAS " + name;
  }

  // Shared club-role pill used across the dashboard surfaces. Kept in
  // step with .verify-flag on members.html and .lb-badge--captain/vice
  // on the leaderboard so the color language stays consistent.
  function clubRolePillClass(cr) {
    var s = String(cr || "").trim().toLowerCase();
    if (s.indexOf("founder") !== -1) return "club-role-pill--founder";
    if (s.indexOf("vice") !== -1) return "club-role-pill--vice";
    if (s.indexOf("captain") !== -1) return "club-role-pill--captain";
    return "club-role-pill--member";
  }
  function buildClubRolePill(cr) {
    var raw = String(cr || "Member").trim() || "Member";
    var span = document.createElement("span");
    span.className = "club-role-pill " + clubRolePillClass(raw);
    span.textContent = raw;
    return span;
  }
  function renderClubRolePill(host, cr) {
    host.innerHTML = "";
    host.appendChild(buildClubRolePill(cr));
  }

  function hydrateProfileForm() {
    if (!user) return;
    var ign = el("profile-ign");
    var name = el("profile-realname");
    var squad = el("profile-squad");
    var games = el("profile-games");
    if (ign) ign.value = user.ign || "";
    if (name) name.value = user.realName || "";
    if (squad) {
      var has = false;
      for (var i = 0; i < squad.options.length; i++) {
        if (squad.options[i].value === user.squad) {
          squad.value = user.squad;
          has = true;
          break;
        }
      }
      if (!has && user.squad) {
        var opt = document.createElement("option");
        opt.value = user.squad;
        opt.textContent = user.squad;
        squad.appendChild(opt);
        squad.value = user.squad;
      }
    }
    if (games) {
      var userGames = (user.games || []).slice();
      var covers =
        ALL_GAMES.length > 0 &&
        ALL_GAMES.every(function (g) {
          return userGames.indexOf(g) !== -1;
        });
      for (var j = 0; j < games.options.length; j++) {
        var optv = games.options[j].value;
        if (optv === "__all__") {
          games.options[j].selected = covers;
        } else {
          games.options[j].selected = userGames.indexOf(optv) !== -1;
        }
      }
    }
  }

  function bindPhotoUpload() {
    var input = el("dash-photo-upload");
    var status = el("dash-photo-status");
    if (!input) return;
    input.addEventListener("change", function () {
      var f = input.files && input.files[0];
      if (!f) return;
      status.textContent = "Processing…";
      window.GarudaImageUtils
        .compressImageFile(f, { maxSide: 900, quality: 0.7 })
        .then(function (dataUrl) {
          return window.GarudaApi.updateProfile({ photoDataUrl: dataUrl });
        })
        .then(function (res) {
          user = (res && res.user) || user;
          status.textContent = "Saved to your account.";
          renderProfile();
          renderDigitalId();
          input.value = "";
        })
        .catch(function (err) {
          status.textContent =
            "Could not save photo: " + ((err && err.message) || "error");
        });
    });
  }

  function bindProfileForm() {
    var form = el("form-profile");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var status = el("profile-status");
      var ign = el("profile-ign").value.trim();
      var realName = el("profile-realname").value.trim();
      var squad = el("profile-squad").value;
      var gamesSel = el("profile-games");
      var picked = [];
      var all = false;
      for (var i = 0; i < gamesSel.options.length; i++) {
        if (gamesSel.options[i].selected) {
          if (gamesSel.options[i].value === "__all__") {
            all = true;
          } else {
            picked.push(gamesSel.options[i].value);
          }
        }
      }
      if (all) picked = ALL_GAMES.slice();
      if (!ign) {
        status.textContent = "IGN is required.";
        return;
      }
      if (!picked.length) {
        status.textContent = "Pick at least one game.";
        return;
      }
      status.textContent = "Saving…";
      window.GarudaApi
        .updateProfile({
          ign: ign,
          realName: realName,
          squad: squad,
          games: picked
        })
        .then(function (res) {
          user = (res && res.user) || user;
          status.textContent = "Profile updated.";
          renderProfile();
          renderDigitalId();
          hydrateProfileForm();
        })
        .catch(function (err) {
          status.textContent = (err && err.message) || "Could not save.";
        });
    });
  }

  // --------------------------------------------------------------------
  // Two-factor authentication (TOTP). The dashboard shows one of three
  // states based on /api/me/2fa/status:
  //   * idle     — user has never set up; "Set up 2FA" button.
  //   * setup    — user clicked Set Up; server returned a fresh secret +
  //                QR. Show the QR + a verify-code input.
  //   * enabled  — user is done; show a disable form that asks for a
  //                fresh code.
  // No client-side caching; every open of the dashboard re-queries status.
  // --------------------------------------------------------------------
  function bindTotp() {
    var card = el("tfa-card");
    if (!card) return;
    var state = el("tfa-state");
    var idle = el("tfa-idle");
    var setup = el("tfa-setup");
    var enabled = el("tfa-enabled");
    var status = el("tfa-status");
    var startBtn = el("tfa-start-btn");
    var cancelBtn = el("tfa-cancel-btn");
    var verifyBtn = el("tfa-verify-btn");
    var verifyCode = el("tfa-verify-code");
    var disableBtn = el("tfa-disable-btn");
    var disableCode = el("tfa-disable-code");
    var qr = el("tfa-qr");
    var secretEl = el("tfa-secret");

    function show(which) {
      idle.hidden = which !== "idle";
      setup.hidden = which !== "setup";
      enabled.hidden = which !== "enabled";
    }

    function refresh() {
      status.textContent = "";
      window.GarudaApi.twoFactor.status()
        .then(function (res) {
          if (res.enabled) {
            state.textContent = "2FA is ON for this account.";
            show("enabled");
          } else {
            state.textContent = "2FA is off. Turn it on to require a code on every sign-in.";
            show("idle");
          }
        })
        .catch(function (err) {
          state.textContent = (err && err.message) || "Couldn't load 2FA state.";
        });
    }

    startBtn.addEventListener("click", function () {
      status.textContent = "Generating secret…";
      window.GarudaApi.twoFactor.setup()
        .then(function (res) {
          secretEl.textContent = res.secret || "";
          if (res.qrDataUrl) {
            qr.src = res.qrDataUrl;
            qr.hidden = false;
          } else {
            qr.hidden = true;
          }
          verifyCode.value = "";
          show("setup");
          status.textContent = "";
          verifyCode.focus();
        })
        .catch(function (err) {
          status.textContent = (err && err.message) || "Couldn't start 2FA setup.";
        });
    });

    cancelBtn.addEventListener("click", function () {
      status.textContent = "";
      refresh();
    });

    verifyBtn.addEventListener("click", function () {
      var code = (verifyCode.value || "").trim();
      if (!/^\d{6}$/.test(code)) {
        status.textContent = "Enter the 6-digit code from your authenticator.";
        return;
      }
      status.textContent = "Verifying…";
      window.GarudaApi.twoFactor.verify(code)
        .then(function () {
          status.textContent = "2FA turned on.";
          refresh();
        })
        .catch(function (err) {
          status.textContent = (err && err.message) || "That code didn't work.";
        });
    });

    disableBtn.addEventListener("click", function () {
      var code = (disableCode.value || "").trim();
      if (!/^\d{6}$/.test(code)) {
        status.textContent = "Enter a current 6-digit code.";
        return;
      }
      status.textContent = "Turning off…";
      window.GarudaApi.twoFactor.disable(code)
        .then(function () {
          status.textContent = "2FA turned off.";
          disableCode.value = "";
          refresh();
        })
        .catch(function (err) {
          status.textContent = (err && err.message) || "Couldn't turn off 2FA.";
        });
    });

    refresh();
  }

  function bindPasswordForm() {
    var form = el("form-password");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var status = el("pw-status");
      var cur = el("pw-current").value;
      var nxt = el("pw-new").value;
      var conf = el("pw-confirm").value;
      if (nxt !== conf) {
        status.textContent = "New passwords don't match.";
        return;
      }
      if (nxt.length < 12) {
        status.textContent = "Password must be at least 12 characters.";
        return;
      }
      status.textContent = "Updating…";
      window.GarudaApi
        .changePassword(cur, nxt)
        .then(function () {
          form.reset();
          status.textContent =
            "Password updated. Other signed-in devices have been signed out.";
        })
        .catch(function (err) {
          status.textContent = (err && err.message) || "Could not update password.";
        });
    });
  }

  // Renders the PRO-games checkbox list once. Each checkbox is keyed by the
  // canonical game name so the submit handler can read selections directly
  // from the DOM without a parallel state object.
  function ensureProGamesList() {
    var list = el("id-meta-pro-list");
    if (!list || list.dataset.built === "1") return list;
    var catalog =
      (window.ProFlags && window.ProFlags.catalog) ||
      [{ name: "Beyblade X" }];
    var html = catalog
      .map(function (g) {
        var id = "id-meta-pro-" + g.name.toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");
        return (
          '<label class="dash-check dash-pro-games__item" for="' + id + '">' +
          '<input type="checkbox" id="' + id + '" data-pro-game="' +
          g.name.replace(/"/g, "&quot;") + '" /> ' +
          'PRO ' + (g.short || g.name).replace(/&/g, "&amp;") +
          '</label>'
        );
      })
      .join("");
    list.innerHTML = html;
    list.dataset.built = "1";
    return list;
  }

  function proCheckboxes() {
    var list = ensureProGamesList();
    if (!list) return [];
    return Array.prototype.slice.call(
      list.querySelectorAll("input[type=checkbox][data-pro-game]")
    );
  }

  function setProSelection(games) {
    var set = Object.create(null);
    (games || []).forEach(function (g) {
      var c = window.ProFlags ? window.ProFlags.canonical(g) : g;
      if (c) set[c] = true;
    });
    proCheckboxes().forEach(function (cb) {
      cb.checked = !!set[cb.dataset.proGame];
    });
  }

  function setProDisabled(disabled) {
    proCheckboxes().forEach(function (cb) {
      cb.disabled = !!disabled;
    });
  }

  function refreshIdFlagControls() {
    ensureProGamesList();
    var cj = el("id-meta-judge");
    var btn = el("id-meta-save");
    var note = el("id-flags-review-note");
    var pending = idFlagsState && idFlagsState.pending;
    var latest = idFlagsState && idFlagsState.latest;
    var verifiedCj = !!(idFlagsState && idFlagsState.verified.certifiedJudge);
    var verifiedPro =
      (idFlagsState && idFlagsState.verified.proGames) ||
      (idFlagsState && idFlagsState.verified.professionalBlader
        ? ["Beyblade X"]
        : []);

    if (note) {
      note.textContent = "";
      note.className = "id-flags-review-note";
      if (pending) {
        note.textContent =
          "Under review by the verification team. The card above still shows your last approved flags until this request is approved.";
        note.classList.add("id-flags-review-note--pending");
      } else if (latest && latest.status === "rejected") {
        note.textContent =
          "Your previous ID flags request was rejected. Verifier note: " +
          (latest.verifierNote || "—") +
          " Adjust the checkboxes and submit again if you want to reapply.";
        note.classList.add("id-flags-review-note--rejected");
      }
    }

    if (pending) {
      if (cj) {
        cj.checked = !!pending.certifiedJudge;
        cj.disabled = true;
      }
      setProSelection(
        pending.proGames ||
          (pending.professionalBlader ? ["Beyblade X"] : [])
      );
      setProDisabled(true);
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Awaiting verification";
      }
    } else {
      if (cj) {
        cj.disabled = false;
        cj.checked = verifiedCj;
      }
      setProSelection(verifiedPro);
      setProDisabled(false);
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Submit for verification";
      }
    }
  }

  function bindIdMetaForm() {
    ensureProGamesList();
    var cj = el("id-meta-judge");
    var btn = el("id-meta-save");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var st = el("id-meta-status");
      var wantCj = !!(cj && cj.checked);
      var wantPro = proCheckboxes()
        .filter(function (c) { return c.checked; })
        .map(function (c) { return c.dataset.proGame; });
      if (st) st.textContent = "Submitting…";
      window.GarudaApi
        .requestIdFlags({
          certifiedJudge: wantCj,
          proGames: wantPro
        })
        .then(function () {
          if (st)
            st.textContent =
              "Submitted for verification. Your digital ID will update after a Verifier approves.";
          return refreshIdFlags();
        })
        .then(function () {
          renderSubmissions();
        })
        .catch(function (err) {
          if (st) st.textContent = (err && err.message) || "Submission failed.";
        });
    });
  }

  // Returns today's date as YYYY-MM-DD in the browser's local timezone so the
  // <input type="date"> max matches what the user sees on their own
  // calendar (avoids a UTC shift rejecting "today" for members in UTC+08).
  function todayIsoLocal() {
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function bindAchievementForm() {
    var form = el("form-achievement");
    if (!form) return;
    var rankSel = el("ach-rank");
    var placeWrap = el("ach-placement-wrap");
    var placeInp = el("ach-placement");
    var playersInp = el("ach-players");
    var dateInp = el("ach-event-date");
    var preview = el("ach-points-preview");
    if (dateInp) {
      var today = todayIsoLocal();
      dateInp.max = today;
      if (!dateInp.min) dateInp.min = "2000-01-01";
    }

    function sync() {
      var code = rankSel.value;
      var isPodium = code === "podium";
      if (placeWrap) placeWrap.hidden = !isPodium;
      if (placeInp) placeInp.required = isPodium;
      if (!isPodium && placeInp) placeInp.value = "";
      updatePreview();
    }

    function updatePreview() {
      if (!preview) return;
      var code = rankSel.value;
      if (!code) {
        preview.textContent = "";
        return;
      }
      var players = parseInt(playersInp.value, 10) || 0;
      var placement = parseInt(placeInp.value, 10) || 0;
      if (code === "podium" && placement < 4) {
        preview.textContent = "Enter a placement of 4 or higher for podium.";
        return;
      }
      var pts = computePoints(code, placement, players);
      var gt = players >= 64;
      var label =
        code === "podium" && placement >= 4
          ? ordinal(placement)
          : RANK_META[code].label;
      preview.textContent =
        "Preview: " +
        label +
        " · " +
        (players ? players + " players" : "player count TBD") +
        " · " +
        (gt ? "GT ×2 multiplier" : "Casual event") +
        " → " +
        pts +
        " pts on approval.";
    }

    rankSel.addEventListener("change", sync);
    placeInp.addEventListener("input", updatePreview);
    playersInp.addEventListener("input", updatePreview);
    sync();

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var eventName = el("ach-event").value.trim();
      var rankCode = rankSel.value;
      var placement = parseInt(placeInp.value, 10) || 0;
      var players = parseInt(playersInp.value, 10) || 0;
      var challonge = el("ach-challonge").value.trim();
      var gameSel = el("ach-game");
      var game = gameSel ? gameSel.value : "Beyblade X";
      var fileIn = el("ach-poster");
      var status = el("ach-form-status");
      var eventDate = dateInp ? dateInp.value : "";
      if (!eventName) {
        status.textContent = "Event name is required.";
        return;
      }
      // JLAP / Certified-Judge activities have their own submission form.
      // Bounce them here so members don't have to wait for verifier feedback
      // to learn they used the wrong queue. The server enforces this too.
      if (eventLooksLikeJlap(eventName)) {
        status.textContent =
          'This looks like JLAP / Certified Judge. Please submit it under "JLAP" instead.';
        return;
      }
      if (!eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
        status.textContent = "Pick the event date.";
        if (dateInp) dateInp.focus();
        return;
      }
      if (eventDate > todayIsoLocal()) {
        status.textContent = "Event date cannot be in the future.";
        if (dateInp) dateInp.focus();
        return;
      }
      if (!rankCode) {
        status.textContent = "Pick a finish.";
        return;
      }
      if (!players || players < 2) {
        status.textContent = "Player count is required.";
        return;
      }
      if (rankCode === "podium" && placement < 4) {
        status.textContent = "Podium placement must be 4 or higher.";
        return;
      }
      var posterFile = fileIn.files && fileIn.files[0];
      function submit(posterDataUrl) {
        window.GarudaApi
          .addAchievement({
            eventName: eventName,
            eventDate: eventDate,
            rankCode: rankCode,
            placement: placement,
            playerCount: players,
            challongeUrl: challonge,
            posterDataUrl: posterDataUrl || "",
            game: game
          })
          .then(function () {
            form.reset();
            sync();
            status.textContent =
              "Submitted for verification. Points apply only after a Verifier approves.";
            return refreshAchievements();
          })
          .then(function () {
            renderSubmissions();
            renderGallery();
          })
          .catch(function (err) {
            status.textContent =
              (err && err.message) || "Could not submit achievement.";
          });
      }
      if (posterFile) {
        status.textContent = "Compressing poster…";
        window.GarudaImageUtils
          .compressImageFile(posterFile, { maxSide: 1000, quality: 0.7 })
          .then(submit)
          .catch(function () {
            status.textContent = "Poster upload failed.";
          });
      } else {
        submit("");
      }
    });
  }

  function bindJlapForm() {
    var form = el("form-jlap");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var cert = el("jlap-cert").files && el("jlap-cert").files[0];
      var qr = el("jlap-qr").files && el("jlap-qr").files[0];
      var status = el("jlap-form-status");
      if (!cert || !qr) {
        status.textContent = "JLAP certificate and QR image are both required.";
        return;
      }
      status.textContent = "Processing uploads…";
      Promise.all([
        window.GarudaImageUtils.compressImageFile(cert, {
          maxSide: 1400,
          quality: 0.75
        }),
        window.GarudaImageUtils.compressImageFile(qr, {
          maxSide: 800,
          quality: 0.8
        })
      ])
        .then(function (pair) {
          return window.GarudaApi.addJlap({
            certificateDataUrl: pair[0],
            qrDataUrl: pair[1]
          });
        })
        .then(function () {
          form.reset();
          status.textContent =
            "JLAP package submitted. A Verifier will review it.";
          return refreshJlap();
        })
        .then(function () {
          renderSubmissions();
        })
        .catch(function (err) {
          status.textContent =
            (err && err.message) || "Upload failed.";
        });
    });
  }

  function statusClass(s) {
    if (s === "verified") return "dash-status--ok";
    if (s === "rejected") return "dash-status--bad";
    return "dash-status--pending";
  }

  function renderSubmissions() {
    var tbody = el("submissions-tbody");
    if (!tbody) return;
    tbody.innerHTML = "";
    var rows = [];
    var me = user ? user.username : "";
    achievements
      .filter(function (a) {
        return a.username === me;
      })
      .forEach(function (r) {
        var detail =
          r.eventName +
          (r.eventDate ? " (" + r.eventDate + ")" : "") +
          " · " +
          r.rank +
          " (" +
          r.rankPoints +
          " pts";
        if (r.playerCount) {
          detail += ", " + r.playerCount + " players";
          if (r.isGrandTournament) detail += ", GT";
        }
        detail += ")";
        rows.push({
          kind: "Achievement",
          detail: detail,
          status: r.status,
          note: r.verifierNote || "—",
          when: r.createdAt
        });
      });
    jlap
      .filter(function (a) {
        return a.username === me;
      })
      .forEach(function (r) {
        rows.push({
          kind: "JLAP",
          detail: "Certificate + QR submission",
          status: r.status,
          note: r.verifierNote || "—",
          when: r.createdAt
        });
      });
    if (idFlagsState && Array.isArray(idFlagsState.history)) {
      idFlagsState.history.forEach(function (r) {
        var parts = [];
        if (r.certifiedJudge) parts.push("Certified Judge");
        var proGames =
          (window.ProFlags && window.ProFlags.normalize(r.proGames)) ||
          (r.professionalBlader ? ["Beyblade X"] : []);
        proGames.forEach(function (g) {
          parts.push(
            window.ProFlags ? window.ProFlags.label(g) : "PRO " + g
          );
        });
        rows.push({
          kind: "ID flags",
          detail: parts.length ? parts.join(", ") : "No flags requested",
          status: r.status,
          note: r.verifierNote || "—",
          when: r.createdAt
        });
      });
    }
    rows.sort(function (a, b) {
      return b.when - a.when;
    });
    if (!rows.length) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        '<td colspan="4" class="dash-table-empty">No submissions yet.</td>';
      tbody.appendChild(tr);
      return;
    }
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var tr2 = document.createElement("tr");
      tr2.innerHTML =
        "<td>" +
        escapeHtml(r.kind) +
        "</td><td>" +
        escapeHtml(r.detail) +
        '</td><td><span class="dash-status ' +
        statusClass(r.status) +
        '">' +
        escapeHtml(r.status) +
        "</span></td><td>" +
        escapeHtml(r.note) +
        "</td>";
      tbody.appendChild(tr2);
    }
  }

  function renderGallery() {
    var wrap = el("dash-gallery");
    if (!wrap) return;
    wrap.innerHTML = "";
    var me = user ? user.username : "";
    // The list endpoint returns hasPoster (boolean) instead of the full
    // image, so we lazy-load each poster per achievement. Legacy field
    // `posterDataUrl` is also accepted for back-compat during rollout.
    var ach = achievements.filter(function (a) {
      return a.username === me && (a.hasPoster || a.posterDataUrl);
    });
    if (!ach.length) {
      wrap.innerHTML =
        '<p class="dash-placeholder">Posters from your achievements appear here.</p>';
      return;
    }
    for (var i = 0; i < ach.length; i++) {
      var a = ach[i];
      var fig = document.createElement("figure");
      fig.className = "dash-gallery__item";
      var img = document.createElement("img");
      img.alt = a.eventName || "Poster";
      img.loading = "lazy";
      if (a.posterDataUrl) {
        img.src = a.posterDataUrl;
      } else if (window.GarudaApi && window.GarudaApi.getAchievement) {
        (function (aid, imgEl) {
          window.GarudaApi
            .getAchievement(aid)
            .then(function (res) {
              var url =
                res && res.achievement && res.achievement.posterDataUrl;
              if (url) imgEl.src = url;
            })
            .catch(function () {
              /* Skip broken rows silently; gallery is best-effort. */
            });
        })(a.id, img);
      }
      var cap = document.createElement("figcaption");
      cap.textContent = a.eventName + " · " + a.status;
      fig.appendChild(img);
      fig.appendChild(cap);
      wrap.appendChild(fig);
    }
  }

  function bindLogout() {
    var logoutBtn = el("dash-logout");
    var navOut = el("nav-logout");
    function out() {
      window.GarudaAuth.logout();
    }
    if (logoutBtn) logoutBtn.addEventListener("click", out);
    if (navOut) navOut.addEventListener("click", out);
  }

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  var INBOX_POLL_TIMER = null;

  function refreshInboxBadge() {
    if (!window.GarudaApi || !window.GarudaApi.notifications) {
      return Promise.resolve();
    }
    return window.GarudaApi
      .notifications({ limit: 1 })
      .then(function (res) {
        var unread = (res && res.unreadCount) || 0;
        var navBadge = el("nav-inbox-badge");
        if (navBadge) {
          if (unread > 0) {
            navBadge.hidden = false;
            navBadge.textContent = String(unread);
          } else {
            navBadge.hidden = true;
          }
        }
      })
      .catch(function () {
        /* ignore transient errors */
      });
  }

  function bindInboxBadge() {
    if (INBOX_POLL_TIMER) clearInterval(INBOX_POLL_TIMER);
    INBOX_POLL_TIMER = setInterval(refreshInboxBadge, 60000);
  }

  function openDigitalIdModal() {
    var modal = el("digital-id-modal");
    if (!modal) return;
    modal.hidden = false;
    document.body.classList.add("admin-modal-open");
    var closeBtn = modal.querySelector(".admin-modal__close");
    if (closeBtn) {
      try {
        closeBtn.focus();
      } catch (e) {
        /* focus is best-effort */
      }
    }
  }

  function closeDigitalIdModal() {
    var modal = el("digital-id-modal");
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove("admin-modal-open");
    var trigger = el("dash-show-id");
    if (trigger) {
      try {
        trigger.focus();
      } catch (e) {
        /* focus is best-effort */
      }
    }
  }

  function bindDigitalIdModal() {
    var openBtn = el("dash-show-id");
    var modal = el("digital-id-modal");
    if (openBtn) {
      openBtn.addEventListener("click", openDigitalIdModal);
    }
    if (modal) {
      var closers = modal.querySelectorAll("[data-id-modal-close]");
      for (var i = 0; i < closers.length; i++) {
        closers[i].addEventListener("click", closeDigitalIdModal);
      }
    }
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (modal && !modal.hidden) closeDigitalIdModal();
    });
  }
})();
