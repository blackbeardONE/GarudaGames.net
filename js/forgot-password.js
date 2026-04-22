(function () {
  var form = document.getElementById("reset-form");
  var tokenEl = document.getElementById("reset-token");
  var newEl = document.getElementById("reset-new");
  var confEl = document.getElementById("reset-confirm");
  var errEl = document.getElementById("reset-error");
  var okEl = document.getElementById("reset-success");
  var submitBtn = form ? form.querySelector('button[type="submit"]') : null;

  if (!form) return;

  // Pre-populate from ?token= on the URL so admin can share a single
  // link instead of a raw token. The value is still editable in case
  // the user wants to correct a paste mishap.
  var qsToken = new URLSearchParams(window.location.search).get("token");
  if (qsToken && tokenEl) tokenEl.value = qsToken.trim();

  function fail(msg) {
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.hidden = false;
    okEl.hidden = true;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    errEl.hidden = true;
    okEl.hidden = true;

    var token = (tokenEl.value || "").trim();
    var nxt = newEl.value || "";
    var conf = confEl.value || "";
    if (!token) return fail("Paste the token the admin sent you.");
    if (nxt.length < 12) return fail("New password must be at least 12 characters.");
    if (nxt !== conf) return fail("The two passwords do not match.");

    submitBtn.disabled = true;
    submitBtn.textContent = "Setting password…";

    window.GarudaApi
      .resetPassword(token, nxt)
      .then(function () {
        okEl.hidden = false;
        setTimeout(function () {
          window.location.href = "login.html?registered=1";
        }, 1500);
      })
      .catch(function (err) {
        fail((err && err.message) || "Could not reset password.");
      })
      .finally(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = "Set new password";
      });
  });

  // --- "Email me a reset link" form ---------------------------------------
  var fForm = document.getElementById("forgot-form");
  var fHandle = document.getElementById("forgot-handle");
  var fErr = document.getElementById("forgot-error");
  var fOk = document.getElementById("forgot-success");
  var fBtn = fForm ? fForm.querySelector('button[type="submit"]') : null;

  if (fForm) {
    fForm.addEventListener("submit", function (e) {
      e.preventDefault();
      fErr.hidden = true;
      fOk.hidden = true;
      var handle = (fHandle.value || "").trim();
      if (!handle) {
        fErr.textContent = "Enter your username or email.";
        fErr.hidden = false;
        return;
      }
      fBtn.disabled = true;
      fBtn.textContent = "Sending…";
      window.GarudaApi
        .forgotPassword(handle)
        .then(function () {
          // Server always returns 200; we never confirm or deny the
          // account exists, so the UI mirrors that.
          fOk.hidden = false;
          fHandle.value = "";
        })
        .catch(function (err) {
          fErr.textContent =
            (err && err.message) ||
            "Could not send a reset link. Try again in a moment.";
          fErr.hidden = false;
        })
        .finally(function () {
          fBtn.disabled = false;
          fBtn.textContent = "Send reset link";
        });
    });
  }
})();
