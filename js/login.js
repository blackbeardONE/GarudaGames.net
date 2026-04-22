(function () {
  var form = document.getElementById("login-form");
  var userEl = document.getElementById("login-username");
  var passEl = document.getElementById("login-password");
  var totpBlock = document.getElementById("login-totp-block");
  var totpEl = document.getElementById("login-totp");
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
