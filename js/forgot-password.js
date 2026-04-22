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
})();
