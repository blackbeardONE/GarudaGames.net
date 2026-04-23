/**
 * v1.19.0 — Staff 2FA banners / pre-gate.
 *
 * Exposes window.GarudaStaff2faGate with:
 *
 *   renderDashboardBanner(user, containerId)
 *       Soft or hard banner at the top of Dashboard for staff
 *       (verifier / admin) whose TOTP is not enabled. Non-staff
 *       users and already-2FA'd staff render nothing.
 *
 *   renderHardGate(user, hostEl)
 *       Replaces hostEl's content with a blocking "enable 2FA first"
 *       panel when the user is staff, without TOTP, and the grace
 *       window has passed. Returns true when the gate was rendered
 *       (so the caller can short-circuit), false otherwise.
 *
 * Keeps all copy in one place so the tone matches wherever we show it.
 */
(function () {
  function sf(user) {
    return (user && user.staffTwoFactor) || null;
  }

  function fmtGrace(graceUntil) {
    if (!graceUntil) return "";
    var d = new Date(graceUntil);
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function renderDashboardBanner(user, containerId) {
    var host = document.getElementById(containerId);
    if (!host) return;
    var status = sf(user);
    if (!status || !status.required || status.enabled) {
      host.innerHTML = "";
      host.hidden = true;
      return;
    }
    var graceActive =
      status.graceUntil && status.graceUntil > Date.now();
    var tone = graceActive ? "warn" : "bad";
    var headline = graceActive
      ? "Enable two-factor authentication before " +
        fmtGrace(status.graceUntil)
      : "Two-factor authentication is required on your account";
    var body = graceActive
      ? "Staff accounts need TOTP (Google Authenticator, 1Password, Authy…) enabled " +
        "by " +
        fmtGrace(status.graceUntil) +
        ". After that date, verifier / admin API calls will be blocked until you " +
        "finish setup. Scroll to <strong>Account → Two-factor authentication</strong> " +
        "to enrol now."
      : "Your role (" +
        (user.role || "staff") +
        ") has TOTP required and the grace window has ended. Verifier / admin " +
        "tools return 403 until you enable 2FA. Scroll to <strong>Account → " +
        "Two-factor authentication</strong> to set it up — you can keep using " +
        "the rest of the dashboard in the meantime.";
    host.hidden = false;
    host.className = "staff-2fa-banner staff-2fa-banner--" + tone;
    host.innerHTML =
      '<strong class="staff-2fa-banner__title">' +
      headline +
      "</strong>" +
      '<p class="staff-2fa-banner__body">' +
      body +
      "</p>";
  }

  function renderHardGate(user, hostEl) {
    if (!hostEl) return false;
    var status = sf(user);
    if (!status || !status.required || status.enabled) return false;
    var graceActive =
      status.graceUntil && status.graceUntil > Date.now();
    if (graceActive) return false;
    hostEl.innerHTML =
      '<section class="staff-2fa-gate" role="alert">' +
      '<h2 class="staff-2fa-gate__title">Two-factor authentication required</h2>' +
      '<p>This page is part of the staff tools (role = <code>' +
      (user.role || "staff") +
      "</code>). v1.19.0 blocks staff API calls that don't have TOTP enabled on " +
      "the account, and the grace window has ended.</p>" +
      '<p>Open the <a href="dashboard.html#dash-account">Dashboard → Account</a> ' +
      "card and enable <strong>Two-factor authentication</strong>. After you " +
      "verify the first TOTP code, reload this page and you're back in.</p>" +
      '<p><a class="btn btn--primary" href="dashboard.html#dash-account">Go to Dashboard</a></p>' +
      "</section>";
    return true;
  }

  window.GarudaStaff2faGate = {
    renderDashboardBanner: renderDashboardBanner,
    renderHardGate: renderHardGate,
  };
})();
