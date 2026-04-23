(function () {
  var pending = document.getElementById("verify-pending");
  var success = document.getElementById("verify-success");
  var errEl = document.getElementById("verify-error");

  function showError(msg) {
    pending.hidden = true;
    success.hidden = true;
    errEl.textContent = msg;
    errEl.hidden = false;
  }
  function showSuccess() {
    pending.hidden = true;
    errEl.hidden = true;
    success.hidden = false;
  }

  var token = new URLSearchParams(window.location.search).get("token");
  if (!token) {
    showError(
      "No verification token in the link. Open the email we sent you and click the full link — don't retype it."
    );
    return;
  }

  window.GarudaApi
    .verifyEmail(token.trim())
    .then(function () {
      showSuccess();
    })
    .catch(function (err) {
      showError(
        (err && err.message) ||
          "That verification link is invalid or has expired."
      );
    });
})();
