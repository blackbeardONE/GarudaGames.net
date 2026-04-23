(function () {
  var form = document.getElementById("login-form");
  var userEl = document.getElementById("login-username");
  var passEl = document.getElementById("login-password");
  var totpBlock = document.getElementById("login-totp-block");
  var totpEl = document.getElementById("login-totp");
  var totpLabel = document.getElementById("login-totp-label");
  var totpHint = document.getElementById("login-totp-hint");
  var useRecoveryLink = document.getElementById("login-use-recovery");
  var errEl = document.getElementById("login-error");
  var regNote = document.getElementById("login-registered-note");
  var submitBtn = form ? form.querySelector('button[type="submit"]') : null;

  if (regNote && new URLSearchParams(window.location.search).get("registered")) {
    regNote.hidden = false;
  }

  function redirectTo(next) {
    var target = next || "dashboard.html";
    if (!/^[a-z0-9_.-]+\.html$/i.test(target)) target = "dashboard.html";
    window.location.href = target;
  }

  window.GarudaAuth.ready().then(function (user) {
    if (user) {
      var params = new URLSearchParams(window.location.search);
      redirectTo(params.get("next") || "dashboard.html");
    }
  });

  if (!form || !userEl || !passEl) return;

  // Toggle between the 6-digit authenticator code input and a 10-char
  // recovery code input. The server accepts either (dispatches on the
  // shape), so all the UI does is relax validation and swap the label.
  var recoveryMode = false;
  function setRecoveryMode(on) {
    recoveryMode = !!on;
    if (!totpEl || !totpLabel) return;
    if (recoveryMode) {
      totpLabel.textContent = "Recovery code";
      totpEl.setAttribute("inputmode", "text");
      totpEl.removeAttribute("pattern");
      totpEl.placeholder = "XXXXX-XXXXX";
      totpEl.value = "";
      totpEl.maxLength = 11;
      if (totpHint) {
        totpHint.innerHTML =
          "Enter one of the ten single-use recovery codes you saved when you turned on 2FA. " +
          '<a href="#" id="login-use-totp">Use authenticator code instead</a>.';
        var back = document.getElementById("login-use-totp");
        if (back) {
          back.addEventListener("click", function (e) {
            e.preventDefault();
            setRecoveryMode(false);
          });
        }
      }
      totpEl.focus();
    } else {
      totpLabel.textContent = "Authenticator code";
      totpEl.setAttribute("inputmode", "numeric");
      totpEl.setAttribute("pattern", "[0-9]{6}");
      totpEl.placeholder = "6-digit code";
      totpEl.value = "";
      totpEl.maxLength = 11;
      if (totpHint) {
        totpHint.innerHTML =
          "This account has two-factor authentication on. Enter the " +
          "current code from your authenticator app, or " +
          '<a href="#" id="login-use-recovery">use a recovery code</a> instead.';
        var link = document.getElementById("login-use-recovery");
        if (link) {
          link.addEventListener("click", function (e) {
            e.preventDefault();
            setRecoveryMode(true);
          });
        }
      }
    }
  }
  if (useRecoveryLink) {
    useRecoveryLink.addEventListener("click", function (e) {
      e.preventDefault();
      setRecoveryMode(true);
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (errEl) {
      errEl.textContent = "";
      errEl.hidden = true;
    }
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Signing in…";
    }
    var payload = {
      username: userEl.value,
      password: passEl.value
    };
    if (totpBlock && !totpBlock.hidden && totpEl && totpEl.value) {
      payload.totpCode = totpEl.value.trim();
    }
    window.GarudaApi
      .login(payload)
      .then(function () {
        return window.GarudaAuth.refresh();
      })
      .then(function (user) {
        if (!user) throw new Error("Session could not be established.");
        var params = new URLSearchParams(window.location.search);
        redirectTo(params.get("next") || "dashboard.html");
      })
      .catch(function (err) {
        // Progressive disclosure: the first wrong-password attempt for a
        // 2FA-enabled account comes back with { totpRequired: true }; we
        // reveal the code field instead of showing a generic error.
        if (
          err && err.data && err.data.totpRequired && totpBlock && totpEl
        ) {
          totpBlock.hidden = false;
          totpEl.focus();
          if (errEl) {
            errEl.textContent =
              "Enter the 6-digit code from your authenticator to finish signing in.";
            errEl.hidden = false;
          }
          return;
        }
        if (errEl) {
          errEl.textContent =
            (err && err.message) ||
            "Invalid username or password.";
          errEl.hidden = false;
        }
      })
      .finally(function () {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Sign in";
        }
      });
  });
})();
