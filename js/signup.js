(function () {
  var form = document.getElementById("signup-form");
  var statusEl = document.getElementById("signup-status");
  var submitBtn = form ? form.querySelector('button[type="submit"]') : null;

  var USERNAME_RE = /^[a-z0-9_]{3,32}$/;

  // The club tag is auto-applied to every blader name across the site, so
  // storing it inside the IGN would end up doubling the prefix. We refuse
  // any IGN that contains the tag (case-insensitive) at signup time.
  function getClubTag() {
    var t =
      window.GarudaSite && typeof window.GarudaSite.clubTag === "string"
        ? window.GarudaSite.clubTag
        : "GRD|TAS";
    return (t || "").trim();
  }
  function ignContainsClubTag(ign) {
    var tag = getClubTag();
    if (!tag) return false;
    // Whitespace-tolerant match: "GRD|TAS", "GRD | TAS", "grd |tas",
    // tabs etc. all count as the tag.
    function squash(s) {
      return String(s || "").replace(/\s+/g, "").toLowerCase();
    }
    var needle = squash(tag);
    if (!needle) return false;
    return squash(ign).indexOf(needle) !== -1;
  }

  var ALL_GAMES = [
    "Beyblade X",
    "Call of Duty: Mobile",
    "Dota 2",
    "Honor of Kings",
    "Mobile Legends",
    "Tekken",
    "Valorant",
  ];

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function clearStatus() {
    if (!statusEl) return;
    statusEl.textContent = "";
    statusEl.className = "dash-upload-status";
  }

  function setStatusSuccess(msg) {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.className = "dash-upload-status";
  }

  function setStatusSingleError(msg) {
    if (!statusEl) return;
    statusEl.innerHTML =
      '<span class="signup-errors__icon" aria-hidden="true">!</span>' +
      '<span>' +
      escapeHtml(msg) +
      "</span>";
    statusEl.className = "dash-upload-status signup-status--err";
    statusEl.setAttribute("role", "alert");
  }

  function setStatusErrorList(messages) {
    if (!statusEl) return;
    if (messages.length === 1) {
      setStatusSingleError(messages[0]);
      return;
    }
    var items = messages
      .map(function (m) {
        return "<li>" + escapeHtml(m) + "</li>";
      })
      .join("");
    statusEl.innerHTML =
      '<div class="signup-errors">' +
      '<p class="signup-errors__title">' +
      '<span class="signup-errors__icon" aria-hidden="true">!</span>' +
      "Please fix the following before continuing:" +
      "</p>" +
      '<ul class="signup-errors__list">' +
      items +
      "</ul>" +
      "</div>";
    statusEl.className = "dash-upload-status signup-status--err";
    statusEl.setAttribute("role", "alert");
  }

  function markInvalid(input, isInvalid) {
    if (!input) return;
    if (isInvalid) {
      input.classList.add("is-invalid");
      input.setAttribute("aria-invalid", "true");
    } else {
      input.classList.remove("is-invalid");
      input.removeAttribute("aria-invalid");
    }
  }

  function clearAllInvalid() {
    if (!form) return;
    var nodes = form.querySelectorAll(".is-invalid");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.remove("is-invalid");
      nodes[i].removeAttribute("aria-invalid");
    }
  }

  // Mirror of the server-side passwordPolicyError so the user sees the
  // issue before a network round trip. The server is still authoritative.
  function clientPasswordError(password, username) {
    var p = String(password || "");
    if (p.length < 12) return "Password must be at least 12 characters.";
    var lower = /[a-z]/.test(p);
    var upper = /[A-Z]/.test(p);
    var digit = /[0-9]/.test(p);
    var symbol = /[^A-Za-z0-9]/.test(p);
    var classes = [lower, upper, digit, symbol].filter(Boolean).length;
    if (p.length < 16 && classes < 3) {
      return "Use at least 3 of: lowercase, uppercase, digit, symbol — or a passphrase of 16+ characters.";
    }
    if (
      username &&
      p.toLowerCase().indexOf(String(username).toLowerCase()) !== -1
    ) {
      return "Password must not contain your username.";
    }
    return null;
  }

  window.GarudaAuth.ready().then(function (user) {
    if (user) {
      window.location.replace("dashboard.html");
    }
  });

  if (!form) return;

  // Clear the invalid state as soon as the user starts correcting the field.
  form.addEventListener(
    "input",
    function (e) {
      var t = e.target;
      if (t && t.classList && t.classList.contains("is-invalid")) {
        markInvalid(t, false);
      }
    },
    true
  );
  form.addEventListener(
    "change",
    function (e) {
      var t = e.target;
      if (t && t.classList && t.classList.contains("is-invalid")) {
        markInvalid(t, false);
      }
    },
    true
  );

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    clearStatus();
    clearAllInvalid();

    var u = document.getElementById("signup-username");
    var p1 = document.getElementById("signup-password");
    var p2 = document.getElementById("signup-password2");
    var ign = document.getElementById("signup-ign");
    var rn = document.getElementById("signup-realname");
    var em = document.getElementById("signup-email");
    var sq = document.getElementById("signup-squad");
    var gamesSel = document.getElementById("signup-games");

    var errors = [];
    var firstInvalid = null;

    function fail(input, message) {
      markInvalid(input, true);
      errors.push(message);
      if (!firstInvalid) firstInvalid = input;
    }

    // Username: required + pattern.
    var uVal = u ? u.value.trim() : "";
    if (!uVal) {
      fail(u, "Username is required.");
    } else if (!USERNAME_RE.test(uVal)) {
      fail(
        u,
        "Username must be 3–32 characters: lowercase letters, digits, and underscores only."
      );
    }

    // Password + confirmation.
    var p1Val = p1 ? p1.value : "";
    var p2Val = p2 ? p2.value : "";
    if (!p1Val) {
      fail(p1, "Password is required.");
    } else {
      var policyErr = clientPasswordError(p1Val, uVal);
      if (policyErr) fail(p1, policyErr);
    }
    if (!p2Val) {
      fail(p2, "Please confirm your password.");
    } else if (p1Val && p2Val !== p1Val) {
      fail(p2, "Passwords do not match.");
    }

    // IGN: required, and must not contain the club tag — the tag is
    // prefixed automatically on every display surface.
    var ignVal = ign ? ign.value.trim() : "";
    if (!ignVal) {
      fail(ign, "In-game name (IGN) is required.");
    } else if (ignContainsClubTag(ignVal)) {
      fail(
        ign,
        'Don\'t include "' +
          getClubTag() +
          '" in your IGN — it\'s added automatically.'
      );
    }

    // Email is optional but, if supplied, must look plausible — server
    // rejects anything that fails the stricter check too.
    var emVal = em ? em.value.trim() : "";
    if (emVal && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emVal)) {
      fail(em, "That email address doesn't look valid.");
    }

    var termsBox = document.getElementById("signup-terms");
    if (termsBox && !termsBox.checked) {
      fail(
        termsBox,
        "You need to agree to the Terms of Use and Privacy Policy to create an account."
      );
    }

    // Squad: required.
    var sqVal = sq ? sq.value : "";
    if (!sqVal) {
      fail(sq, "Please select a squad.");
    }

    // Games: at least one selection.
    var games = [];
    if (gamesSel && gamesSel.selectedOptions) {
      for (var i = 0; i < gamesSel.selectedOptions.length; i++) {
        games.push(gamesSel.selectedOptions[i].value);
      }
    }
    if (games.indexOf("__all__") !== -1) {
      games = ALL_GAMES.slice();
    }
    if (!games.length) {
      fail(gamesSel, "Select at least one game (or choose All Games).");
    }

    if (errors.length) {
      setStatusErrorList(errors);
      if (firstInvalid) {
        try {
          firstInvalid.focus({ preventScroll: false });
        } catch (err) {
          try {
            firstInvalid.focus();
          } catch (err2) {
            /* ignore */
          }
        }
      }
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Creating account…";
    }
    window.GarudaApi
      .register({
        username: uVal,
        password: p1Val,
        ign: ignVal,
        realName: rn ? rn.value.trim() : "",
        email: em ? em.value.trim() : "",
        squad: sqVal,
        clubRole: "Member",
        games: games,
      })
      .then(function (res) {
        setStatusSuccess(
          res.isFirst
            ? "Your admin account is ready. Redirecting to sign in…"
            : "Account created. Redirecting to sign in…"
        );
        setTimeout(function () {
          window.location.href = "login.html?registered=1";
        }, 700);
      })
      .catch(function (err) {
        setStatusSingleError(
          (err && err.message) || "Could not create account."
        );
      })
      .finally(function () {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Create account";
        }
      });
  });
})();
