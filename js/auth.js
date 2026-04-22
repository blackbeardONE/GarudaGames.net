/**
 * Thin auth shim backed by the Garuda Games API.
 * The authoritative user record comes from /api/auth/me and is cached on
 * window.GarudaAuth._user for the current page.
 */
(function () {
  var cached = null;
  var ready = null;

  function refresh() {
    ready = window.GarudaApi.me()
      .then(function (res) {
        cached = (res && res.user) || null;
        return cached;
      })
      .catch(function () {
        cached = null;
        return null;
      });
    return ready;
  }

  function ensureReady() {
    return ready || refresh();
  }

  function getUser() {
    return cached;
  }

  function getRole() {
    return cached ? cached.role : null;
  }

  function requireSessionOrRedirect(nextUrl) {
    return ensureReady().then(function (u) {
      if (!u) {
        var q = nextUrl ? "?next=" + encodeURIComponent(nextUrl) : "";
        window.location.replace("login.html" + q);
        return null;
      }
      return u;
    });
  }

  function requireRoleOrRedirect(minRole, fallbackUrl) {
    var order = { user: 0, verifier: 1, admin: 2 };
    return ensureReady().then(function (u) {
      if (!u) {
        window.location.replace(
          "login.html?next=" +
            encodeURIComponent(window.location.pathname.replace(/^\//, ""))
        );
        return null;
      }
      if ((order[u.role] || 0) < (order[minRole] || 0)) {
        window.location.replace(fallbackUrl || "dashboard.html");
        return null;
      }
      return u;
    });
  }

  function logout() {
    return window.GarudaApi.logout()
      .catch(function () {})
      .then(function () {
        cached = null;
        ready = null;
        window.location.href = "login.html";
      });
  }

  window.GarudaAuth = {
    refresh: refresh,
    ready: ensureReady,
    getUser: getUser,
    getRole: getRole,
    requireSessionOrRedirect: requireSessionOrRedirect,
    requireRoleOrRedirect: requireRoleOrRedirect,
    logout: logout
  };

  refresh();
})();
