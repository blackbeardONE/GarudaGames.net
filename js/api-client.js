/**
 * Thin fetch() wrapper for the Garuda Games JSON API.
 * Uses same-origin cookies (session cookie) for auth.
 */
(function () {
  var BASE = "/api";

  function withJson(opts, body) {
    var out = Object.assign({ credentials: "same-origin" }, opts || {});
    out.headers = Object.assign(
      { Accept: "application/json" },
      out.headers || {}
    );
    if (body !== undefined) {
      out.headers["Content-Type"] = "application/json";
      out.body = JSON.stringify(body);
    }
    return out;
  }

  // Throw a friendly error if the client is trying to send payloads that will
  // blow past the server's JSON body limit. Keeps the UX honest and prevents
  // a silent 413 after a long compression step.
  var MAX_BODY = 3_800_000;

  function apiRequest(method, url, body) {
    var opts = withJson({ method: method }, body);
    if (opts.body && typeof opts.body === "string" && opts.body.length > MAX_BODY) {
      return Promise.reject(new Error("That upload is too large."));
    }
    return fetch(BASE + url, opts).then(function (
      r
    ) {
      return r
        .json()
        .catch(function () {
          return { ok: false, error: "Invalid server response." };
        })
        .then(function (data) {
          if (!r.ok || data.ok === false) {
            var msg = (data && data.error) || ("HTTP " + r.status);
            var err = new Error(msg);
            err.status = r.status;
            err.data = data;
            throw err;
          }
          return data;
        });
    });
  }

  window.GarudaApi = {
    base: BASE,
    health: function () {
      return apiRequest("GET", "/health");
    },

    stats: function () {
      return apiRequest("GET", "/auth/stats");
    },
    register: function (payload) {
      return apiRequest("POST", "/auth/register", payload);
    },
    login: function (payload) {
      return apiRequest("POST", "/auth/login", payload);
    },
    logout: function () {
      return apiRequest("POST", "/auth/logout", {});
    },
    me: function () {
      return apiRequest("GET", "/auth/me");
    },
    updateProfile: function (patch) {
      return apiRequest("PATCH", "/me/profile", patch);
    },
    changePassword: function (currentPassword, newPassword) {
      return apiRequest("PATCH", "/me/password", {
        currentPassword: currentPassword,
        newPassword: newPassword
      });
    },
    twoFactor: {
      status: function () {
        return apiRequest("GET", "/me/2fa/status");
      },
      setup: function () {
        return apiRequest("POST", "/me/2fa/setup", {});
      },
      verify: function (code) {
        return apiRequest("POST", "/me/2fa/verify", { code: code });
      },
      disable: function (code) {
        return apiRequest("POST", "/me/2fa/disable", { code: code });
      },
      recoveryStatus: function () {
        return apiRequest("GET", "/me/2fa/recovery-codes/status");
      },
      regenerateRecoveryCodes: function (password, code) {
        return apiRequest("POST", "/me/2fa/recovery-codes/regenerate", {
          password: password,
          code: code
        });
      }
    },
    resetPassword: function (token, newPassword) {
      return apiRequest("POST", "/auth/reset-password", {
        token: token,
        newPassword: newPassword
      });
    },
    forgotPassword: function (usernameOrEmail) {
      return apiRequest("POST", "/auth/forgot-password", {
        usernameOrEmail: usernameOrEmail
      });
    },
    verifyEmail: function (token) {
      return apiRequest("POST", "/auth/verify-email", { token: token });
    },
    sendVerificationEmail: function () {
      return apiRequest("POST", "/me/email/send-verification", {});
    },
    listSessions: function () {
      return apiRequest("GET", "/me/sessions");
    },
    revokeSession: function (id) {
      return apiRequest("DELETE", "/me/sessions/" + encodeURIComponent(id));
    },
    revokeAllOtherSessions: function () {
      return apiRequest("POST", "/me/sessions/revoke-all", {});
    },
    deleteAccount: function (payload) {
      return apiRequest("POST", "/me/delete", payload || {});
    },
    // Export uses a direct download URL since the server sets
    // Content-Disposition; the browser handles the save dialog.
    exportUrl: function () {
      return "/api/me/export";
    },
    adminIssueResetToken: function (username) {
      return apiRequest(
        "POST",
        "/admin/members/" + encodeURIComponent(username) + "/reset-token",
        {}
      );
    },
    adminDisableTwoFactor: function (username) {
      return apiRequest(
        "POST",
        "/admin/members/" + encodeURIComponent(username) + "/2fa/disable",
        {}
      );
    },
    notifications: function (opts) {
      var qs = opts && opts.limit ? "?limit=" + encodeURIComponent(opts.limit) : "";
      return apiRequest("GET", "/me/notifications" + qs);
    },
    markNotificationsRead: function (payload) {
      return apiRequest("POST", "/me/notifications/read", payload || { all: true });
    },
    leaderboard: function (opts) {
      var params = [];
      if (opts && opts.game && opts.game !== "all") {
        params.push("game=" + encodeURIComponent(opts.game));
      }
      if (opts && opts.season && opts.season !== "all") {
        params.push("season=" + encodeURIComponent(opts.season));
      }
      var qs = params.length ? "?" + params.join("&") : "";
      return apiRequest("GET", "/leaderboard" + qs);
    },
    verifierLeaderboard: function (opts) {
      var win = opts && opts.window === "all" ? "all" : "90d";
      return apiRequest("GET", "/verifiers/leaderboard?window=" + encodeURIComponent(win));
    },

    listMembers: function () {
      return apiRequest("GET", "/members");
    },
    lookupMember: function (query) {
      return apiRequest("POST", "/members/lookup", { query: query });
    },
    // Public blader portfolio. Handle is a username OR IGN (server matches
    // both, case-insensitive). No auth required — the response is trimmed
    // to career-public fields only.
    getPortfolio: function (handle) {
      return apiRequest(
        "GET",
        "/portfolio/" + encodeURIComponent(String(handle || ""))
      );
    },

    listAchievements: function () {
      return apiRequest("GET", "/achievements");
    },
    // Fetches a single achievement including the full poster data URL. The
    // list endpoint returns a lite view (hasPoster boolean) so the queue
    // stays small; use this when the user actually wants to preview.
    getAchievement: function (id) {
      return apiRequest("GET", "/achievements/" + encodeURIComponent(id));
    },
    addAchievement: function (row) {
      return apiRequest("POST", "/achievements", row);
    },
    reviewAchievement: function (id, patch) {
      return apiRequest("PATCH", "/achievements/" + encodeURIComponent(id), patch);
    },
    // Verifier-only. Backfills the event_date on an already-verified row
    // without touching status/points. Used by the "Missing dates" queue
    // where legacy approvals are brought up to the new season rules.
    backfillAchievementDate: function (id, eventDate) {
      return apiRequest(
        "PATCH",
        "/achievements/" + encodeURIComponent(id) + "/event-date",
        { eventDate: eventDate }
      );
    },

    listJlap: function () {
      return apiRequest("GET", "/jlap");
    },
    getJlap: function (id) {
      return apiRequest("GET", "/jlap/" + encodeURIComponent(id));
    },
    addJlap: function (row) {
      return apiRequest("POST", "/jlap", row);
    },
    reviewJlap: function (id, patch) {
      return apiRequest("PATCH", "/jlap/" + encodeURIComponent(id), patch);
    },

    myIdFlags: function () {
      return apiRequest("GET", "/id-flags/me");
    },
    // payload: { certifiedJudge, proGames, evidence: [{ game, league, photoDataUrl, linkUrl, note }] }
    // `evidence` is required for every newly-claimed PRO pill (v1.14.0).
    requestIdFlags: function (payload) {
      return apiRequest("POST", "/id-flags/request", payload);
    },
    pendingIdFlags: function () {
      return apiRequest("GET", "/id-flags/pending");
    },
    // Full fetch for a single ID flag request including the base64 evidence
    // photos. Used by the verifier lightbox and the owner's own dashboard.
    getIdFlag: function (id) {
      return apiRequest("GET", "/id-flags/" + encodeURIComponent(id));
    },
    reviewIdFlags: function (id, patch) {
      return apiRequest("PATCH", "/id-flags/" + encodeURIComponent(id), patch);
    },

    // v1.24.0 — rejected-submission appeals. The member posts their
    // 500-char explanation; the verifier either accepts (row returns
    // to the main queue) or denies (terminal for that rejection).
    appealAchievement: function (id, text) {
      return apiRequest(
        "POST",
        "/achievements/" + encodeURIComponent(id) + "/appeal",
        { appealText: text }
      );
    },
    appealJlap: function (id, text) {
      return apiRequest(
        "POST",
        "/jlap/" + encodeURIComponent(id) + "/appeal",
        { appealText: text }
      );
    },
    appealIdFlags: function (id, text) {
      return apiRequest(
        "POST",
        "/id-flags/" + encodeURIComponent(id) + "/appeal",
        { appealText: text }
      );
    },
    listPendingAppeals: function () {
      return apiRequest("GET", "/admin/appeals");
    },
    resolveAppeal: function (kind, id, action, verifierNote) {
      var path =
        kind === "achievement"
          ? "/admin/achievements/"
          : kind === "jlap"
          ? "/admin/jlap/"
          : "/admin/id-flags/";
      return apiRequest(
        "POST",
        path + encodeURIComponent(id) + "/appeal/resolve",
        { action: action, verifierNote: verifierNote || "" }
      );
    },

    listNews: function (opts) {
      var params = [];
      if (opts && opts.limit) {
        params.push("limit=" + encodeURIComponent(opts.limit));
      }
      if (opts && opts.drafts) params.push("drafts=1");
      var qs = params.length ? "?" + params.join("&") : "";
      return apiRequest("GET", "/news" + qs);
    },
    getNews: function (id) {
      return apiRequest("GET", "/news/" + encodeURIComponent(id));
    },
    adminCreateNews: function (payload) {
      return apiRequest("POST", "/admin/news", payload);
    },
    adminUpdateNews: function (id, patch) {
      return apiRequest("PATCH", "/admin/news/" + encodeURIComponent(id), patch);
    },
    adminDeleteNews: function (id) {
      return apiRequest("DELETE", "/admin/news/" + encodeURIComponent(id));
    },

    getSite: function () {
      return apiRequest("GET", "/site");
    },
    saveSite: function (payload) {
      return apiRequest("PUT", "/admin/site", payload);
    },
    adminMembers: function () {
      return apiRequest("GET", "/admin/members");
    },
    adminGetMember: function (username) {
      return apiRequest(
        "GET",
        "/admin/members/" + encodeURIComponent(username)
      );
    },
    adminCreateMember: function (payload) {
      return apiRequest("POST", "/admin/members", payload);
    },
    adminUpdateMember: function (username, patch) {
      return apiRequest(
        "PATCH",
        "/admin/members/" + encodeURIComponent(username),
        patch
      );
    },
    adminDeleteMember: function (username) {
      return apiRequest(
        "DELETE",
        "/admin/members/" + encodeURIComponent(username)
      );
    },
    adminGetMemberSecurity: function (username) {
      return apiRequest(
        "GET",
        "/admin/members/" + encodeURIComponent(username) + "/security"
      );
    },
    adminAudit: function (opts) {
      var params = [];
      if (opts) {
        if (opts.limit) params.push("limit=" + encodeURIComponent(opts.limit));
        if (opts.before) params.push("before=" + encodeURIComponent(opts.before));
        if (opts.action) params.push("action=" + encodeURIComponent(opts.action));
        if (opts.actor) params.push("actor=" + encodeURIComponent(opts.actor));
        if (opts.target) params.push("target=" + encodeURIComponent(opts.target));
        if (opts.since) params.push("since=" + encodeURIComponent(opts.since));
      }
      var qs = params.length ? "?" + params.join("&") : "";
      return apiRequest("GET", "/admin/audit" + qs);
    },
    adminStaff2faStatus: function () {
      return apiRequest("GET", "/admin/staff-2fa-status");
    },
    adminStaff2faNudge: function (target) {
      return apiRequest("POST", "/admin/staff-2fa-nudge", { target: target });
    },
    adminCacheStats: function (opts) {
      var qs = opts && opts.reset ? "?reset=1" : "";
      return apiRequest("GET", "/admin/cache-stats" + qs);
    }
  };
})();
