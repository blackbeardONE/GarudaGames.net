(function () {
  if (!window.GarudaAuth || !window.GarudaApi) {
    console.error("Missing Garuda modules");
    return;
  }

  function el(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function inboxWhen(ts) {
    if (!ts) return "";
    var diff = Date.now() - ts;
    var m = 60 * 1000;
    var h = 60 * m;
    var day = 24 * h;
    if (diff < m) return "just now";
    if (diff < h) return Math.floor(diff / m) + "m ago";
    if (diff < day) return Math.floor(diff / h) + "h ago";
    if (diff < 7 * day) return Math.floor(diff / day) + "d ago";
    var d = new Date(ts);
    return isNaN(d.getTime())
      ? ""
      : d.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
  }

  var CACHE = { items: [], unread: 0 };
  var POLL_TIMER = null;

  function refreshInbox() {
    if (!window.GarudaApi.notifications) return Promise.resolve();
    return window.GarudaApi
      .notifications({ limit: 100 })
      .then(function (res) {
        CACHE.items = (res && res.notifications) || [];
        CACHE.unread = (res && res.unreadCount) || 0;
        renderInbox();
      })
      .catch(function () {
        /* ignore transient errors */
      });
  }

  function renderInbox() {
    var list = el("dash-inbox-list");
    var empty = el("dash-inbox-empty");
    var badge = el("dash-inbox-badge");
    var markAll = el("dash-inbox-mark-all");
    var navBadge = el("nav-inbox-badge");
    if (!list) return;
    list.innerHTML = "";
    if (navBadge) {
      if (CACHE.unread > 0) {
        navBadge.hidden = false;
        navBadge.textContent = String(CACHE.unread);
      } else {
        navBadge.hidden = true;
      }
    }
    if (!CACHE.items.length) {
      if (empty) empty.hidden = false;
      if (badge) badge.hidden = true;
      if (markAll) markAll.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;
    if (badge) {
      if (CACHE.unread > 0) {
        badge.hidden = false;
        badge.textContent = String(CACHE.unread);
      } else {
        badge.hidden = true;
      }
    }
    if (markAll) markAll.hidden = CACHE.unread === 0;
    CACHE.items.forEach(function (n) {
      var li = document.createElement("li");
      li.className =
        "dash-inbox__item" + (n.readAt ? "" : " dash-inbox__item--unread");
      li.dataset.id = n.id;
      li.innerHTML =
        '<div class="dash-inbox__head">' +
        '<span class="dash-inbox__kind dash-inbox__kind--' +
        escapeHtml(n.kind || "info") +
        '">' +
        escapeHtml(n.kind || "info") +
        "</span>" +
        '<h3 class="dash-inbox__title">' +
        escapeHtml(n.title || "") +
        "</h3>" +
        '<time class="dash-inbox__time">' +
        escapeHtml(inboxWhen(n.createdAt)) +
        "</time>" +
        "</div>" +
        '<p class="dash-inbox__body">' +
        escapeHtml(n.body || "") +
        "</p>";
      list.appendChild(li);
    });
  }

  function bindInbox() {
    var list = el("dash-inbox-list");
    var markAll = el("dash-inbox-mark-all");
    if (list) {
      list.addEventListener("click", function (e) {
        var li = e.target.closest
          ? e.target.closest(".dash-inbox__item--unread")
          : null;
        if (!li || !li.dataset.id) return;
        var id = li.dataset.id;
        li.classList.remove("dash-inbox__item--unread");
        window.GarudaApi
          .markNotificationsRead({ ids: [id] })
          .then(refreshInbox);
      });
    }
    if (markAll) {
      markAll.addEventListener("click", function () {
        markAll.disabled = true;
        window.GarudaApi
          .markNotificationsRead({ all: true })
          .then(refreshInbox)
          .finally(function () {
            markAll.disabled = false;
          });
      });
    }
    if (POLL_TIMER) clearInterval(POLL_TIMER);
    POLL_TIMER = setInterval(refreshInbox, 60000);
  }

  function bindLogout() {
    var btns = [
      document.getElementById("nav-logout"),
      document.getElementById("dash-logout")
    ];
    btns.forEach(function (b) {
      if (!b) return;
      b.addEventListener("click", function () {
        window.GarudaAuth.logout().then(function () {
          window.location.href = "index.html";
        });
      });
    });
  }

  window.GarudaAuth
    .requireSessionOrRedirect("inbox.html")
    .then(function (u) {
      if (!u) return null;
      bindInbox();
      bindLogout();
      return refreshInbox();
    })
    .catch(function (err) {
      console.error(err);
    });
})();
