/**
 * Reveal Dashboard / role links once we know there's a session.
 * Also surfaces the unread inbox count on the nav badge.
 */
(function () {
  var INBOX_POLL_TIMER = null;
  var NEWS_POLL_TIMER = null;
  var NEWS_LAST_SEEN_KEY = "garuda:newsLastSeenAt";

  function applyVisibility(user) {
    var role = user ? user.role : null;
    var nav = document.getElementById("nav-dashboard");
    if (nav) nav.hidden = !user;
    var foot = document.getElementById("footer-dashboard-link");
    if (foot) foot.hidden = !user;
    var navInbox = document.getElementById("nav-inbox");
    if (navInbox) navInbox.hidden = !user;
    var navVerifier = document.getElementById("nav-verifier");
    if (navVerifier)
      navVerifier.hidden = !(role === "verifier" || role === "admin");
    var navAdmin = document.getElementById("nav-admin");
    if (navAdmin) navAdmin.hidden = role !== "admin";
    var navVerifierIdx = document.getElementById("nav-verifier-index");
    if (navVerifierIdx)
      navVerifierIdx.hidden = !(role === "verifier" || role === "admin");
    var navAdminIdx = document.getElementById("nav-admin-index");
    if (navAdminIdx) navAdminIdx.hidden = role !== "admin";
    var navAdminVerif = document.getElementById("nav-admin-verif");
    if (navAdminVerif) navAdminVerif.hidden = role !== "admin";
    var loginLink = document.querySelector('a[href="login.html"]');
    var signupLink = document.querySelector('a[href="signup.html"]');
    if (user) {
      if (loginLink && !loginLink.hasAttribute("aria-current")) {
        loginLink.hidden = true;
      }
      if (signupLink && !signupLink.hasAttribute("aria-current")) {
        signupLink.hidden = true;
      }
      startInboxPolling();
    }
    startNewsPolling();
  }

  function refreshInboxBadge() {
    if (!window.GarudaApi || !window.GarudaApi.notifications) return;
    var badge = document.getElementById("nav-inbox-badge");
    if (!badge) return;
    window.GarudaApi
      .notifications({ limit: 1 })
      .then(function (res) {
        var unread = (res && res.unreadCount) || 0;
        if (unread > 0) {
          badge.hidden = false;
          badge.textContent = String(unread);
        } else {
          badge.hidden = true;
        }
      })
      .catch(function () {
        /* ignore transient errors */
      });
  }

  function startInboxPolling() {
    if (!document.getElementById("nav-inbox-badge")) return;
    refreshInboxBadge();
    if (INBOX_POLL_TIMER) clearInterval(INBOX_POLL_TIMER);
    INBOX_POLL_TIMER = setInterval(refreshInboxBadge, 60000);
  }

  // Show a "NEW" chip next to the News nav link when the newest published
  // post is newer than the user's locally stored last-seen timestamp. The
  // news page itself clears this by writing the freshest timestamp back.
  function refreshNewsBadge() {
    if (!window.GarudaApi || !window.GarudaApi.listNews) return;
    var badge = document.getElementById("nav-news-badge");
    if (!badge) return;
    // Skip on the News page itself — it will mark everything seen on load.
    var onNewsPage = !!document.querySelector(
      '#nav-news[aria-current="page"]'
    );
    window.GarudaApi
      .listNews({ limit: 1 })
      .then(function (res) {
        var latest = (res && res.latestAt) || 0;
        if (!latest) {
          badge.hidden = true;
          return;
        }
        var seenStr = null;
        try {
          seenStr = localStorage.getItem(NEWS_LAST_SEEN_KEY);
        } catch (_) {
          /* storage disabled */
        }
        var seen = parseInt(seenStr || "0", 10) || 0;
        if (onNewsPage) {
          try {
            localStorage.setItem(NEWS_LAST_SEEN_KEY, String(latest));
          } catch (_) {
            /* ignore */
          }
          badge.hidden = true;
          return;
        }
        badge.hidden = latest <= seen;
      })
      .catch(function () {
        /* transient — leave badge as-is */
      });
  }

  function startNewsPolling() {
    if (!document.getElementById("nav-news-badge")) return;
    refreshNewsBadge();
    if (NEWS_POLL_TIMER) clearInterval(NEWS_POLL_TIMER);
    NEWS_POLL_TIMER = setInterval(refreshNewsBadge, 5 * 60 * 1000);
  }

  function run() {
    if (!window.GarudaAuth || !window.GarudaAuth.ready) return;
    window.GarudaAuth.ready().then(applyVisibility);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
