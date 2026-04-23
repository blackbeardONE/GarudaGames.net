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

  function hasVerifiedEmail() {
    return !!(user && user.hasEmail && user.emailVerified);
  }

  // v1.15.0: Any action that grants a flag (JLAP -> Judge, new PRO pill)
  // is gated on the user having a verified email. Gate state is reflected
  // in two places on the Dashboard:
  //   * #jlap-email-gate      — shown if the user has no verified email
  //     regardless of what they've typed; disables the JLAP submit button
  //     so the server 400 never actually fires for this case.
  //   * #id-meta-email-gate   — shown when the user is about to ADD a
  //     new PRO pill (selection \ verified) and has no verified email;
  //     the submit button is disabled in that case too.
  // refreshEmailGates() is cheap (a few DOM reads) and is called from
  // every place that touches user state or PRO checkbox selection.
  function refreshEmailGates() {
    var verified = hasVerifiedEmail();

    var jlapGate = el("jlap-email-gate");
    if (jlapGate) jlapGate.hidden = verified;
    var jlapForm = el("form-jlap");
    if (jlapForm) {
      var jlapBtn = jlapForm.querySelector('button[type="submit"]');
      if (jlapBtn) {
        if (!verified) {
          jlapBtn.disabled = true;
          jlapBtn.title = "Verify your email first.";
        } else {
          jlapBtn.disabled = false;
          jlapBtn.removeAttribute("title");
        }
      }
    }

    var metaGate = el("id-meta-email-gate");
    var metaBtn = el("id-meta-save");
    if (metaGate) {
      var verifiedPro =
        (idFlagsState && idFlagsState.verified.proGames) ||
        (idFlagsState && idFlagsState.verified.professionalBlader
          ? ["Beyblade X"]
          : []);
      var selected = (typeof proCheckboxes === "function"
        ? proCheckboxes()
            .filter(function (c) { return c.checked; })
            .map(function (c) { return c.dataset.proGame; })
        : []);
      var addingNew = selected.some(function (g) {
        return verifiedPro.indexOf(g) === -1;
      });
      var gateOn = addingNew && !verified;
      metaGate.hidden = !gateOn;
      if (metaBtn && gateOn) {
        metaBtn.disabled = true;
        metaBtn.title = "Verify your email first.";
      } else if (metaBtn) {
        // Re-enable only if the normal control flow allowed it — don't
        // override the "Awaiting verification" state set by
        // refreshIdFlagControls() when a pending request is open.
        if (metaBtn.textContent === "Submit for verification") {
          metaBtn.disabled = false;
          metaBtn.removeAttribute("title");
        }
      }
    }
  }

  window.GarudaAuth
    .requireSessionOrRedirect("dashboard.html")
    .then(function (u) {
      if (!u) return null;
      user = u;
      renderProfile();
      renderDigitalId();
      if (window.GarudaStaff2faGate) {
        window.GarudaStaff2faGate.renderDashboardBanner(u, "staff-2fa-banner");
      }
      renderRecoveryAlert(u);
      hydrateProfileForm();
      bindPhotoUpload();
      bindAchievementForm();
      bindJlapForm();
      bindIdMetaForm();
      bindProfileForm();
      bindPasswordForm();
      bindTotp();
      bindSessions();
      bindDataRights();
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

  // renderRecoveryAlert paints a top-of-dashboard banner whenever a
  // staff user (verifier / admin) has <= 3 recovery codes remaining.
  // Regular users already see the same info inside the TOTP panel; for
  // staff the lockout risk is materially higher once v1.19 enforcement
  // is on, so we elevate the warning above the fold.
  function renderRecoveryAlert(u) {
    var host = el("dash-recovery-alert");
    if (!host) return;
    host.hidden = true;
    if (!u) return;
    var isStaff = u.role === "verifier" || u.role === "admin";
    if (!isStaff) return;
    if (!u.totpEnabled) return;
    window.GarudaApi.twoFactor
      .recoveryStatus()
      .then(function (res) {
        if (!res || !res.enabled) return;
        var remaining = Number(res.remaining || 0);
        var total = Number(res.total || 0);
        if (remaining > 3) return;
        host.classList.remove(
          "dash-recovery-alert--bad"
        );
        if (remaining === 0) host.classList.add("dash-recovery-alert--bad");
        var title =
          remaining === 0
            ? "0 recovery codes left"
            : remaining + " of " + (total || 10) + " recovery codes left";
        var body =
          remaining === 0
            ? "You have no recovery codes. If you lose your authenticator app you will be locked out of your " +
              u.role +
              " account — a fresh set takes 10 seconds to mint."
            : "You only have " +
              remaining +
              " one-time recovery code" +
              (remaining === 1 ? "" : "s") +
              " left. Staff accounts are hard-gated at the end of the 2FA grace window, so please regenerate before you run out.";
        host.innerHTML =
          '<strong class="dash-recovery-alert__title">' +
          title +
          "</strong>" +
          '<p class="dash-recovery-alert__body">' +
          body +
          " " +
          '<a class="dash-recovery-alert__cta" href="#tfa-recovery-summary">Regenerate now\u2192</a>' +
          "</p>";
        host.hidden = false;
      })
      .catch(function () {
        // silent — the in-panel summary still shows if this happens
      });
  }

  function refreshJlap() {
    return window.GarudaApi.listJlap().then(function (r) {
      jlap = (r && r.jlap) || [];
      renderJlapStatus();
    });
  }

  // renderJlapStatus fills the #jlap-status-block with the user's
  // current Certified Judge standing. It surfaces:
  //   * remaining days until expiry for a live grant (>30d calm, 30/14/7
  //     warn, <=0 expired), with a "Renew now" hint inside the window.
  //   * a neutral line when a submission is still under review or was
  //     rejected.
  // The block stays hidden when there is no JLAP history at all so the
  // card reads the same for brand-new users as it always did.
  function renderJlapStatus() {
    var block = el("jlap-status-block");
    if (!block) return;
    var label = el("jlap-status-label");
    var detail = el("jlap-status-detail");
    var renew = el("jlap-status-renew");

    if (!jlap.length) {
      block.hidden = true;
      return;
    }

    var verified = null;
    var pending = null;
    var rejected = null;
    for (var i = 0; i < jlap.length; i += 1) {
      var row = jlap[i];
      if (row.status === "verified" && !verified) verified = row;
      else if (row.status === "pending" && !pending) pending = row;
      else if (row.status === "rejected" && !rejected) rejected = row;
    }

    function setTone(toneClass) {
      block.className = "dash-jlap-status " + toneClass;
    }

    if (pending) {
      block.hidden = false;
      setTone("dash-jlap-status--pending");
      if (label) label.textContent = "JLAP under review";
      if (detail)
        detail.textContent =
          "A Verifier will take a look. You'll be notified in your inbox.";
      if (renew) renew.hidden = true;
      return;
    }

    if (verified) {
      block.hidden = false;
      if (label) label.textContent = "Certified Judge";
      if (verified.expiresAt) {
        var now = Date.now();
        var msLeft = verified.expiresAt - now;
        var daysLeft = Math.floor(msLeft / (24 * 60 * 60 * 1000));
        var expiryDate = new Date(verified.expiresAt).toLocaleDateString();
        if (msLeft <= 0) {
          setTone("dash-jlap-status--expired");
          if (label) label.textContent = "Judge grant expired";
          if (detail)
            detail.textContent =
              "Your JLAP grant expired on " +
              expiryDate +
              ". Submit a fresh package to restore the flag.";
          if (renew) renew.hidden = false;
        } else if (daysLeft <= 30) {
          setTone("dash-jlap-status--warn");
          if (detail)
            detail.textContent =
              "Expires " +
              expiryDate +
              " (" +
              daysLeft +
              " day" +
              (daysLeft === 1 ? "" : "s") +
              " left).";
          if (renew) renew.hidden = false;
        } else {
          setTone("dash-jlap-status--ok");
          if (detail)
            detail.textContent = "Expires " + expiryDate + ".";
          if (renew) renew.hidden = true;
        }
      } else {
        setTone("dash-jlap-status--ok");
        if (detail)
          detail.textContent = "Verified. No expiry on file yet.";
        if (renew) renew.hidden = true;
      }
      return;
    }

    if (rejected) {
      block.hidden = false;
      setTone("dash-jlap-status--rejected");
      if (label) label.textContent = "JLAP not verified";
      if (detail)
        detail.textContent =
          "Your last submission was not approved. You can upload a new package below.";
      if (renew) renew.hidden = true;
      return;
    }

    block.hidden = true;
  }

  function refreshIdFlags() {
    return window.GarudaApi.myIdFlags().then(function (r) {
      idFlagsState = r || null;
      refreshIdFlagControls();
    });
  }

  function renderProfile() {
    if (!user) return;
    var photo = user.photoUrl || user.photoDataUrl || "images/Garuda Logo.jpg";
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
      cardPhoto.src = user.photoUrl || user.photoDataUrl || "images/Garuda Logo.jpg";
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
    var email = el("profile-email");
    var squad = el("profile-squad");
    var games = el("profile-games");
    if (ign) ign.value = user.ign || "";
    if (name) name.value = user.realName || "";
    if (email) email.value = user.email || "";
    renderEmailStatus();
    syncEmailPasswordVisibility();
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

  // Render the "verified / verify now / not set" status block under the
  // email field. The visible state drives off the /auth/me payload —
  // hasEmail + emailVerified — and a "Resend verification" button that
  // hits the new v1.8.0 endpoint.
  function renderEmailStatus() {
    var box = el("profile-email-status");
    refreshEmailGates();
    if (!box || !user) return;
    if (!user.hasEmail) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    if (user.emailVerified) {
      box.innerHTML =
        '<span class="admin-inline-note admin-inline-note--ok">\u2713 Verified.</span>' +
        " Self-service password reset is enabled for this address.";
      return;
    }
    box.innerHTML =
      '<span class="admin-inline-note admin-inline-note--warn">Not verified.</span> ' +
      "Click the link we sent you; without that, password reset emails won't go to this address. " +
      '<button type="button" class="btn btn--ghost btn--sm" id="profile-email-resend">Resend verification</button>' +
      ' <span id="profile-email-resend-status" aria-live="polite"></span>';
    var btn = el("profile-email-resend");
    if (btn) {
      btn.addEventListener("click", function () {
        var s = el("profile-email-resend-status");
        btn.disabled = true;
        var oldLabel = btn.textContent;
        btn.textContent = "Sending\u2026";
        window.GarudaApi
          .sendVerificationEmail()
          .then(function (res) {
            if (res && res.alreadyVerified) {
              if (s) s.textContent = "already verified \u2014 refresh the page.";
            } else if (s) {
              s.textContent =
                "sent. Check your inbox (and spam folder); the link expires in 24 hours.";
            }
          })
          .catch(function (err) {
            if (s)
              s.textContent = (err && err.message) || "Could not send. Try again shortly.";
          })
          .finally(function () {
            btn.disabled = false;
            btn.textContent = oldLabel;
          });
      });
    }
  }

  // v1.11.0: the "current password" input on the profile form is only
  // useful when the member is actually changing their email. Toggle
  // visibility off the live value of the email input vs what we have
  // on record — that way the field stays hidden for casual edits
  // (IGN, squad, games) and only surfaces when the server is going to
  // demand it.
  function syncEmailPasswordVisibility() {
    var emailInput = el("profile-email");
    var wrapper = el("profile-email-password-label");
    var pw = el("profile-email-password");
    if (!emailInput || !wrapper || !pw) return;
    var current = (user && user.email) || "";
    var next = emailInput.value.trim();
    var changed = next !== current;
    wrapper.hidden = !changed;
    if (!changed) pw.value = "";
  }

  function bindProfileForm() {
    var form = el("form-profile");
    if (!form) return;
    var emailInput = el("profile-email");
    if (emailInput) {
      emailInput.addEventListener("input", syncEmailPasswordVisibility);
    }
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var status = el("profile-status");
      var ign = el("profile-ign").value.trim();
      var realName = el("profile-realname").value.trim();
      var emailEl = el("profile-email");
      var email = emailEl ? emailEl.value.trim() : "";
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
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        status.textContent = "That email address doesn't look valid.";
        return;
      }
      var currentEmail = (user && user.email) || "";
      var emailChanged = email !== currentEmail;
      var payload = {
        ign: ign,
        realName: realName,
        email: email,
        squad: squad,
        games: picked
      };
      if (emailChanged) {
        var pw = el("profile-email-password");
        var pwVal = pw ? pw.value : "";
        if (!pwVal) {
          status.textContent =
            "Enter your current password to change the email.";
          if (pw) pw.focus();
          return;
        }
        payload.currentPassword = pwVal;
      }
      status.textContent = "Saving…";
      window.GarudaApi
        .updateProfile(payload)
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

    // v1.12.0 recovery-codes panel.
    var recSummary = el("tfa-recovery-summary");
    var recRegenBtn = el("tfa-recovery-regen-btn");
    var recRegenForm = el("tfa-recovery-regen-form");
    var recRegenConfirm = el("tfa-recovery-regen-confirm");
    var recRegenCancel = el("tfa-recovery-regen-cancel");
    var recRegenPw = el("tfa-recovery-password");
    var recRegenCode = el("tfa-recovery-code");
    var recNewPanel = el("tfa-recovery-new");
    var recNewList = el("tfa-recovery-list");
    var recNewStatus = el("tfa-recovery-new-status");
    var recDownloadBtn = el("tfa-recovery-download");
    var recCopyBtn = el("tfa-recovery-copy");
    var recDismissBtn = el("tfa-recovery-dismiss");

    function show(which) {
      idle.hidden = which !== "idle";
      setup.hidden = which !== "setup";
      enabled.hidden = which !== "enabled";
    }

    // Render the set of just-minted codes into the "save these" panel.
    // This is the only place we ever display plaintext codes in the UI.
    function showRecoveryCodes(codes) {
      if (!recNewPanel || !recNewList) return;
      recNewList.innerHTML = "";
      for (var i = 0; i < codes.length; i++) {
        var li = document.createElement("li");
        li.textContent = codes[i];
        recNewList.appendChild(li);
      }
      recNewPanel.hidden = false;
      if (recNewStatus) recNewStatus.textContent = "";
      if (recNewPanel.scrollIntoView) {
        recNewPanel.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }

    function hideRecoveryCodes() {
      if (!recNewPanel || !recNewList) return;
      recNewList.innerHTML = "";
      recNewPanel.hidden = true;
    }

    function refreshRecoveryStatus() {
      if (!recSummary) return;
      window.GarudaApi.twoFactor
        .recoveryStatus()
        .then(function (res) {
          if (!res.enabled) {
            recSummary.textContent = "";
            return;
          }
          if (res.remaining === 0) {
            recSummary.innerHTML =
              "<strong>0 recovery codes remaining.</strong> " +
              "Regenerate now so you have a way back in if you lose your authenticator.";
          } else if (res.remaining <= 3) {
            recSummary.innerHTML =
              "<strong>" +
              res.remaining +
              " of " +
              res.total +
              "</strong> recovery codes remaining. " +
              "Consider regenerating before you run out.";
          } else {
            recSummary.textContent =
              res.remaining +
              " of " +
              res.total +
              " recovery codes remaining. Each works once, at sign-in, instead of an authenticator code.";
          }
        })
        .catch(function (err) {
          recSummary.textContent =
            (err && err.message) || "Couldn't load recovery-code status.";
        });
    }

    function refresh() {
      status.textContent = "";
      hideRecoveryCodes();
      if (recRegenForm) recRegenForm.hidden = true;
      window.GarudaApi.twoFactor.status()
        .then(function (res) {
          if (res.enabled) {
            state.textContent = "2FA is ON for this account.";
            show("enabled");
            refreshRecoveryStatus();
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
        .then(function (res) {
          status.textContent = "2FA turned on.";
          show("enabled");
          refreshRecoveryStatus();
          if (res && Array.isArray(res.recoveryCodes) && res.recoveryCodes.length) {
            showRecoveryCodes(res.recoveryCodes);
          }
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

    // ---- Recovery code regeneration ----
    if (recRegenBtn && recRegenForm) {
      recRegenBtn.addEventListener("click", function () {
        recRegenForm.hidden = false;
        if (recRegenPw) recRegenPw.value = "";
        if (recRegenCode) recRegenCode.value = "";
        if (recRegenPw) recRegenPw.focus();
      });
    }
    if (recRegenCancel && recRegenForm) {
      recRegenCancel.addEventListener("click", function () {
        recRegenForm.hidden = true;
      });
    }
    if (recRegenConfirm) {
      recRegenConfirm.addEventListener("click", function () {
        var pw = recRegenPw ? recRegenPw.value : "";
        var code = recRegenCode ? (recRegenCode.value || "").trim() : "";
        if (!pw) {
          status.textContent = "Enter your current password.";
          return;
        }
        if (!/^\d{6}$/.test(code)) {
          status.textContent = "Enter a current 6-digit authenticator code.";
          return;
        }
        status.textContent = "Regenerating…";
        window.GarudaApi.twoFactor
          .regenerateRecoveryCodes(pw, code)
          .then(function (res) {
            status.textContent = "New recovery codes generated.";
            recRegenForm.hidden = true;
            if (recRegenPw) recRegenPw.value = "";
            if (recRegenCode) recRegenCode.value = "";
            refreshRecoveryStatus();
            if (res && Array.isArray(res.recoveryCodes)) {
              showRecoveryCodes(res.recoveryCodes);
            }
          })
          .catch(function (err) {
            status.textContent =
              (err && err.message) || "Could not regenerate codes.";
          });
      });
    }

    // ---- Download / copy / dismiss for the "save these" panel ----
    function collectCodesAsText() {
      if (!recNewList) return "";
      var items = recNewList.querySelectorAll("li");
      var lines = [];
      for (var i = 0; i < items.length; i++) {
        lines.push(items[i].textContent || "");
      }
      var header = [
        "Garuda Games — 2FA recovery codes",
        "Generated: " + new Date().toISOString(),
        "Each code works ONCE at sign-in instead of an authenticator code.",
        "Store somewhere safe — password manager, printed page, etc.",
        ""
      ].join("\n");
      return header + lines.join("\n") + "\n";
    }
    if (recDownloadBtn) {
      recDownloadBtn.addEventListener("click", function () {
        var text = collectCodesAsText();
        try {
          var blob = new Blob([text], { type: "text/plain;charset=utf-8" });
          var url = URL.createObjectURL(blob);
          var a = document.createElement("a");
          a.href = url;
          var uname = (user && user.username) || "account";
          a.download = "garudagames-recovery-" + uname + ".txt";
          document.body.appendChild(a);
          a.click();
          setTimeout(function () {
            URL.revokeObjectURL(url);
            a.parentNode && a.parentNode.removeChild(a);
          }, 0);
          if (recNewStatus)
            recNewStatus.textContent = "Downloaded.";
        } catch (e) {
          if (recNewStatus)
            recNewStatus.textContent = "Download failed: " + e.message;
        }
      });
    }
    if (recCopyBtn) {
      recCopyBtn.addEventListener("click", function () {
        var text = collectCodesAsText();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(
            function () {
              if (recNewStatus)
                recNewStatus.textContent = "Copied to clipboard.";
            },
            function () {
              if (recNewStatus)
                recNewStatus.textContent = "Copy failed — select and copy manually.";
            }
          );
        } else if (recNewStatus) {
          recNewStatus.textContent =
            "Clipboard not available — use Download instead.";
        }
      });
    }
    if (recDismissBtn) {
      recDismissBtn.addEventListener("click", function () {
        hideRecoveryCodes();
      });
    }

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

  // v1.14.0 per-game evidence sub-form. For every newly-ticked PRO game
  // (i.e. one that's NOT already in the user's verified list), the panel
  // renders a photo + link input; Beyblade X also requires a league
  // picker (PBBL/XT/XV). Evidence for already-verified games is not
  // required — the server only validates *added* games.
  function gameSlug(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function renderEvidencePanel(selectedGames, verifiedGames) {
    var host = el("id-meta-evidence");
    if (!host) return;
    var verifiedSet = Object.create(null);
    (verifiedGames || []).forEach(function (g) {
      var c = window.ProFlags ? window.ProFlags.canonical(g) : g;
      if (c) verifiedSet[c] = true;
    });
    var addedGames = (selectedGames || []).filter(function (g) {
      return !verifiedSet[g];
    });
    // Preserve current user input when re-rendering (ticking a second box
    // shouldn't clear the first box's link field).
    var prevState = Object.create(null);
    Array.prototype.forEach.call(
      host.querySelectorAll(".dash-pro-evidence__item"),
      function (node) {
        var g = node.dataset.game;
        prevState[g] = {
          league: (node.querySelector('[data-role="league"]') || {}).value || "",
          link: (node.querySelector('[data-role="link"]') || {}).value || "",
          note: (node.querySelector('[data-role="note"]') || {}).value || "",
          // Photo input cannot be programmatically re-populated for
          // security reasons; the user will have to re-pick the file if
          // the node is re-rendered. Ticking boxes one-by-one avoids it.
        };
      }
    );
    if (!addedGames.length) {
      host.innerHTML = "";
      host.hidden = true;
      return;
    }
    host.hidden = false;
    host.innerHTML = addedGames
      .map(function (g) {
        var slug = gameSlug(g);
        var esc = function (s) {
          return String(s == null ? "" : s).replace(/"/g, "&quot;");
        };
        var pst = prevState[g] || {};
        var isBBX = g === "Beyblade X";
        var leagueRow = isBBX
          ? '<label class="dash-pro-evidence__field">' +
              "League" +
              '<select data-role="league" id="ev-' + slug + '-league">' +
                '<option value="">Pick the circuit…</option>' +
                '<option value="PBBL"' + (pst.league === "PBBL" ? " selected" : "") +
                  ">PBBL — Philippine Beyblade Battle League</option>" +
                '<option value="XT"' + (pst.league === "XT" ? " selected" : "") +
                  ">XT — Xtreme Throwdown</option>" +
                '<option value="XV"' + (pst.league === "XV" ? " selected" : "") +
                  ">XV — Xtreme Vertex</option>" +
              "</select>" +
            "</label>"
          : "";
        var linkLabel = isBBX ? "Challonge bracket URL" : "Social-media post URL";
        var linkPlaceholder = isBBX
          ? "https://challonge.com/…"
          : "https://facebook.com/… or any FB / X / IG / TikTok / YouTube post";
        return (
          '<div class="dash-pro-evidence__item" data-game="' + esc(g) + '">' +
          '<div class="dash-pro-evidence__head">Evidence for PRO ' + esc(g) + "</div>" +
          leagueRow +
          '<label class="dash-pro-evidence__field">' +
            "Photo (JPG/PNG, optional if link provided)" +
            '<input type="file" accept="image/*" data-role="photo" />' +
          "</label>" +
          '<label class="dash-pro-evidence__field">' +
            esc(linkLabel) +
            '<input type="url" inputmode="url" data-role="link" ' +
              'placeholder="' + esc(linkPlaceholder) + '" ' +
              'value="' + esc(pst.link) + '" />' +
          "</label>" +
          '<label class="dash-pro-evidence__field">' +
            "Optional note (event, round, date)" +
            '<input type="text" maxlength="500" data-role="note" ' +
              'value="' + esc(pst.note) + '" />' +
          "</label>" +
          "</div>"
        );
      })
      .join("");
  }

  // Read the current evidence panel into the payload shape expected by
  // POST /api/id-flags/request. Photos are compressed to stay under the
  // MAX_POSTER_URL server cap. Returns a promise resolving to an array of
  // evidence entries (one per newly-ticked game).
  function collectEvidencePayload() {
    var host = el("id-meta-evidence");
    if (!host || host.hidden) return Promise.resolve([]);
    var items = Array.prototype.slice.call(
      host.querySelectorAll(".dash-pro-evidence__item")
    );
    if (!items.length) return Promise.resolve([]);
    var jobs = items.map(function (node) {
      var game = node.dataset.game || "";
      var leagueEl = node.querySelector('[data-role="league"]');
      var photoEl = node.querySelector('[data-role="photo"]');
      var linkEl = node.querySelector('[data-role="link"]');
      var noteEl = node.querySelector('[data-role="note"]');
      var league = leagueEl ? leagueEl.value : "";
      var link = linkEl ? linkEl.value.trim() : "";
      var note = noteEl ? noteEl.value.trim() : "";
      var file = photoEl && photoEl.files && photoEl.files[0];
      var entry = {
        game: game,
        league: league,
        linkUrl: link,
        note: note,
        photoDataUrl: "",
      };
      if (!file) return Promise.resolve(entry);
      return window.GarudaImageUtils
        .compressImageFile(file, { maxSide: 1400, quality: 0.75 })
        .then(function (dataUrl) {
          entry.photoDataUrl = dataUrl || "";
          return entry;
        })
        .catch(function () { return entry; });
    });
    return Promise.all(jobs);
  }

  function refreshIdFlagControls() {
    ensureProGamesList();
    var cj = el("id-meta-judge");
    var judgeHint = el("id-judge-hint");
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

    // The Judge checkbox is now read-only unless the user already has the
    // flag (in which case they can untick to self-relinquish). New Judge
    // claims must go through the JLAP upload card.
    if (cj) {
      if (pending) {
        cj.checked = !!pending.certifiedJudge;
        cj.disabled = true;
      } else {
        cj.checked = verifiedCj;
        cj.disabled = !verifiedCj; // only togglable while currently a judge
      }
    }
    if (judgeHint) judgeHint.hidden = !!verifiedCj && !pending;

    if (pending) {
      setProSelection(
        pending.proGames ||
          (pending.professionalBlader ? ["Beyblade X"] : [])
      );
      setProDisabled(true);
      renderEvidencePanel([], verifiedPro);
      var evHost = el("id-meta-evidence");
      if (evHost) {
        evHost.hidden = false;
        evHost.innerHTML =
          '<p class="dash-pro-games__help">Evidence for this request is ' +
          "locked while a Verifier reviews it.</p>";
      }
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Awaiting verification";
      }
    } else {
      setProSelection(verifiedPro);
      setProDisabled(false);
      renderEvidencePanel(verifiedPro, verifiedPro);
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Submit for verification";
      }
    }
    refreshEmailGates();
  }

  function bindIdMetaForm() {
    ensureProGamesList();
    var cj = el("id-meta-judge");
    var btn = el("id-meta-save");
    if (!btn) return;

    // Every time a PRO-game checkbox flips, re-render the evidence panel
    // so inputs for newly-added games appear (and inputs for un-ticked
    // games disappear) in real time.
    proCheckboxes().forEach(function (cb) {
      cb.addEventListener("change", function () {
        var verifiedPro =
          (idFlagsState && idFlagsState.verified.proGames) ||
          (idFlagsState && idFlagsState.verified.professionalBlader
            ? ["Beyblade X"]
            : []);
        var selected = proCheckboxes()
          .filter(function (c) { return c.checked; })
          .map(function (c) { return c.dataset.proGame; });
        renderEvidencePanel(selected, verifiedPro);
        refreshEmailGates();
      });
    });

    btn.addEventListener("click", function () {
      var st = el("id-meta-status");
      var wantCj = !!(cj && cj.checked);
      var wantPro = proCheckboxes()
        .filter(function (c) { return c.checked; })
        .map(function (c) { return c.dataset.proGame; });
      if (st) st.textContent = "Preparing evidence…";
      collectEvidencePayload()
        .then(function (evidence) {
          if (st) st.textContent = "Submitting…";
          return window.GarudaApi.requestIdFlags({
            certifiedJudge: wantCj,
            proGames: wantPro,
            evidence: evidence,
          });
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
      return a.username === me && (a.hasPoster || a.posterUrl || a.posterDataUrl);
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
      // v1.23.0 — posterUrl is the preferred slim reference (served
      // by /api/blob/<sha>); posterDataUrl remains as a fallback for
      // legacy rows that haven't been backfilled yet. Only fall back
      // to the single-record fetch if neither is present on the list
      // row (which happens when the list endpoint was still on the
      // old slim view for that row).
      if (a.posterUrl) {
        img.src = a.posterUrl;
      } else if (a.posterDataUrl) {
        img.src = a.posterDataUrl;
      } else if (window.GarudaApi && window.GarudaApi.getAchievement) {
        (function (aid, imgEl) {
          window.GarudaApi
            .getAchievement(aid)
            .then(function (res) {
              var a2 = res && res.achievement;
              var url =
                (a2 && (a2.posterUrl || a2.posterDataUrl)) || "";
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

  function bindDataRights() {
    var btn = el("delete-account-btn");
    var pw = el("delete-password");
    var tot = el("delete-totp");
    var totLabel = el("delete-totp-label");
    var confirm = el("delete-confirm");
    var status = el("delete-status");
    if (!btn) return;

    // Show the TOTP row only when 2FA is on.
    if (user && user.totpEnabled) {
      if (tot) tot.hidden = false;
      if (totLabel) totLabel.hidden = false;
    }

    btn.addEventListener("click", function () {
      if (status) status.textContent = "";
      var confirmVal = confirm ? confirm.value.trim() : "";
      if (confirmVal !== (user && user.username)) {
        if (status)
          status.textContent =
            'Type your exact username in the confirmation box ("' +
            (user && user.username) +
            '") to proceed.';
        return;
      }
      if (
        !window.confirm(
          "This will permanently delete your Garuda Games account. Are you sure?"
        )
      ) {
        return;
      }
      btn.disabled = true;
      var oldLabel = btn.textContent;
      btn.textContent = "Deleting\u2026";
      window.GarudaApi
        .deleteAccount({
          password: pw ? pw.value : "",
          confirm: confirmVal,
          totpCode: tot ? tot.value.trim() : "",
        })
        .then(function () {
          window.location.href = "index.html?deleted=1";
        })
        .catch(function (err) {
          if (status)
            status.textContent = (err && err.message) || "Could not delete.";
          btn.disabled = false;
          btn.textContent = oldLabel;
        });
    });
  }

  function formatRelative(ts) {
    if (!ts) return "never";
    var s = Math.max(1, Math.round((Date.now() - Number(ts)) / 1000));
    if (s < 60) return s + "s ago";
    var m = Math.round(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.round(m / 60);
    if (h < 24) return h + "h ago";
    var d = Math.round(h / 24);
    if (d < 14) return d + "d ago";
    try {
      return new Date(Number(ts)).toISOString().slice(0, 10);
    } catch (_e) {
      return "a while ago";
    }
  }

  function renderSessionRow(s) {
    var badge = s.isCurrent
      ? '<span class="session-badge session-badge--current">This device</span>'
      : "";
    var platform = s.platform ? " · " + escapeHtml(s.platform) : "";
    var ip = s.ip ? " · " + escapeHtml(s.ip) : "";
    var location = s.location ? " · " + escapeHtml(s.location) : "";
    var revokeBtn = s.isCurrent
      ? ""
      : '<button type="button" class="btn btn--ghost btn--sm" data-session-revoke="' +
        escapeHtml(s.id) +
        '">Revoke</button>';
    return (
      '<li class="session-row">' +
      '<div class="session-row__head">' +
      '<strong>' +
      escapeHtml(s.browser || "Browser") +
      "</strong>" +
      platform +
      ip +
      " " +
      badge +
      "</div>" +
      '<div class="session-row__meta">' +
      "Last seen " +
      escapeHtml(formatRelative(s.lastSeenAt || s.createdAt)) +
      " · Signed in " +
      escapeHtml(formatRelative(s.createdAt)) +
      location +
      "</div>" +
      '<div class="session-row__actions">' +
      revokeBtn +
      "</div>" +
      "</li>"
    );
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return (
        {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[c] || c
      );
    });
  }

  function refreshSessions() {
    var list = el("sessions-list");
    if (!list) return Promise.resolve();
    return window.GarudaApi.listSessions()
      .then(function (res) {
        var sessions = (res && res.sessions) || [];
        if (!sessions.length) {
          list.innerHTML =
            '<p class="dash-card__hint">No active sessions. (That\u2019s odd \u2014 you\u2019re reading this.)</p>';
          return;
        }
        list.innerHTML =
          '<ul class="session-list">' +
          sessions.map(renderSessionRow).join("") +
          "</ul>";
        var revokeBtns = list.querySelectorAll("[data-session-revoke]");
        for (var i = 0; i < revokeBtns.length; i++) {
          revokeBtns[i].addEventListener("click", handleSessionRevoke);
        }
      })
      .catch(function (err) {
        list.innerHTML =
          '<p class="dash-card__hint">Could not load sessions: ' +
          escapeHtml((err && err.message) || "unknown error") +
          "</p>";
      });
  }

  function handleSessionRevoke(e) {
    var btn = e.currentTarget;
    var id = btn.getAttribute("data-session-revoke");
    var status = el("sessions-status");
    btn.disabled = true;
    btn.textContent = "Revoking\u2026";
    window.GarudaApi.revokeSession(id)
      .then(function () {
        if (status) status.textContent = "Session revoked.";
        return refreshSessions();
      })
      .catch(function (err) {
        if (status)
          status.textContent = (err && err.message) || "Could not revoke.";
        btn.disabled = false;
        btn.textContent = "Revoke";
      });
  }

  function bindSessions() {
    var refreshBtn = el("sessions-refresh-btn");
    var revokeAllBtn = el("sessions-revoke-all-btn");
    var status = el("sessions-status");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", function () {
        if (status) status.textContent = "";
        refreshSessions();
      });
    }
    if (revokeAllBtn) {
      revokeAllBtn.addEventListener("click", function () {
        if (
          !confirm(
            "Sign out every other device that's currently signed in? You'll stay signed in on this one."
          )
        ) {
          return;
        }
        revokeAllBtn.disabled = true;
        var oldLabel = revokeAllBtn.textContent;
        revokeAllBtn.textContent = "Revoking\u2026";
        window.GarudaApi.revokeAllOtherSessions()
          .then(function (res) {
            if (status)
              status.textContent =
                "Signed out " +
                ((res && res.revoked) || 0) +
                " other session(s).";
            return refreshSessions();
          })
          .catch(function (err) {
            if (status)
              status.textContent = (err && err.message) || "Could not revoke.";
          })
          .finally(function () {
            revokeAllBtn.disabled = false;
            revokeAllBtn.textContent = oldLabel;
          });
      });
    }
    refreshSessions();
  }
})();
