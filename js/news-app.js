/**
 * News page controller.
 *
 * Public: renders the list of published news posts.
 * Admin: also renders a composer (create/edit/delete) and a "drafts" toggle.
 *
 * Unread tracking is entirely client-side — we store the timestamp of the
 * newest post the user has seen in localStorage under LAST_SEEN_KEY and
 * nav-session.js compares that to /api/news `latestAt` to flash a "NEW"
 * chip on the nav.
 */
(function () {
  if (!window.GarudaApi) {
    return;
  }

  var LAST_SEEN_KEY = "garuda:newsLastSeenAt";

  function el(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function formatWhen(ts) {
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
      : d.toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "2-digit",
        });
  }

  function categoryLabel(cat) {
    switch ((cat || "update").toLowerCase()) {
      case "feature":
        return "New feature";
      case "fix":
        return "Fix";
      case "announcement":
        return "Announcement";
      case "event":
        return "Event";
      default:
        return "Update";
    }
  }

  var STATE = {
    viewer: null,
    isAdmin: false,
    posts: [],
    latestAt: 0,
    filter: "",
    editingId: null,
  };

  function markAllSeen() {
    try {
      if (STATE.latestAt) {
        localStorage.setItem(LAST_SEEN_KEY, String(STATE.latestAt));
      } else {
        localStorage.setItem(LAST_SEEN_KEY, String(Date.now()));
      }
    } catch (_) {
      /* storage disabled — no-op */
    }
    var badge = el("nav-news-badge");
    if (badge) badge.hidden = true;
  }

  function fetchNews() {
    var loading = el("news-loading");
    if (loading) loading.hidden = false;
    return window.GarudaApi
      .listNews({ limit: 50, drafts: STATE.isAdmin ? 1 : 0 })
      .then(function (res) {
        STATE.posts = (res && res.news) || [];
        STATE.latestAt = (res && res.latestAt) || 0;
        render();
        markAllSeen();
      })
      .catch(function (err) {
        if (loading) {
          loading.textContent =
            "Could not load news: " + ((err && err.message) || "error");
        }
      });
  }

  function postSnippet(post) {
    // When no body is set, re-use the summary so the card isn't empty after
    // expansion. Body is already sanitized server-side, so we can trust it.
    var body = post.body && post.body.trim();
    return body || "<p>" + escapeHtml(post.summary || "") + "</p>";
  }

  function renderPost(post) {
    var cat = (post.category || "update").toLowerCase();
    var draftTag = post.published
      ? ""
      : '<span class="news-card__draft">Draft</span>';
    var pinnedTag = post.pinned
      ? '<span class="news-card__pinned" title="Pinned">★ Pinned</span>'
      : "";
    var versionTag = post.version
      ? '<span class="news-card__version">v' +
        escapeHtml(post.version) +
        "</span>"
      : "";
    var adminControls = STATE.isAdmin
      ? '<div class="news-card__admin">' +
        '<button type="button" class="btn btn--ghost btn--sm" data-news-edit="' +
        escapeHtml(post.id) +
        '">Edit</button>' +
        '<button type="button" class="btn btn--ghost btn--sm news-card__delete" data-news-del="' +
        escapeHtml(post.id) +
        '">Delete</button>' +
        "</div>"
      : "";

    return (
      '<li class="news-card news-card--' +
      escapeHtml(cat) +
      (post.pinned ? " news-card--pinned" : "") +
      (post.published ? "" : " news-card--draft") +
      '">' +
      '<div class="news-card__head">' +
      '<span class="news-card__kind news-card__kind--' +
      escapeHtml(cat) +
      '">' +
      escapeHtml(categoryLabel(cat)) +
      "</span>" +
      pinnedTag +
      versionTag +
      draftTag +
      '<time class="news-card__time" datetime="' +
      new Date(post.createdAt || Date.now()).toISOString() +
      '">' +
      escapeHtml(formatWhen(post.createdAt)) +
      "</time>" +
      "</div>" +
      '<h3 class="news-card__title">' +
      escapeHtml(post.title || "") +
      "</h3>" +
      '<p class="news-card__summary">' +
      escapeHtml(post.summary || "") +
      "</p>" +
      '<div class="news-card__body">' +
      postSnippet(post) +
      "</div>" +
      adminControls +
      "</li>"
    );
  }

  function render() {
    var list = el("news-list");
    var empty = el("news-empty");
    var loading = el("news-loading");
    if (!list) return;
    if (loading) loading.hidden = true;

    var filtered = STATE.posts.filter(function (p) {
      if (!STATE.filter) return true;
      return (p.category || "update").toLowerCase() === STATE.filter;
    });

    if (!filtered.length) {
      list.innerHTML = "";
      if (empty) {
        empty.hidden = false;
        empty.textContent = STATE.filter
          ? "Nothing in that category yet."
          : "No posts yet. Check back soon!";
      }
      return;
    }
    if (empty) empty.hidden = true;
    list.innerHTML = filtered.map(renderPost).join("");
  }

  function bindComposer() {
    var form = el("news-form");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var status = el("news-form-status");
      if (status) {
        status.textContent = "Saving…";
        status.classList.remove("is-error");
      }
      var payload = {
        title: el("news-title").value.trim(),
        summary: el("news-summary").value.trim(),
        body: el("news-body").value,
        category: el("news-category").value,
        version: el("news-version").value.trim(),
        pinned: el("news-pinned").checked,
        published: el("news-published").checked,
      };
      var editingId = el("news-edit-id").value;
      var p = editingId
        ? window.GarudaApi.adminUpdateNews(editingId, payload)
        : window.GarudaApi.adminCreateNews(payload);
      p.then(function () {
        resetComposer();
        if (status) status.textContent = editingId ? "Updated." : "Posted.";
        return fetchNews();
      }).catch(function (err) {
        if (status) {
          status.textContent = "Failed: " + ((err && err.message) || "error");
          status.classList.add("is-error");
        }
      });
    });

    el("news-cancel").addEventListener("click", function () {
      resetComposer();
    });

    var newBtn = el("news-new-post");
    if (newBtn) {
      newBtn.addEventListener("click", function () {
        resetComposer();
        var card = el("news-composer-card");
        if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
        el("news-title").focus();
      });
    }
  }

  function resetComposer() {
    el("news-form").reset();
    el("news-edit-id").value = "";
    el("news-published").checked = true;
    el("news-pinned").checked = false;
    el("news-category").value = "update";
    el("news-composer-title").textContent = "Post an update";
    el("news-submit").textContent = "Post update";
    el("news-cancel").hidden = true;
    var status = el("news-form-status");
    if (status) {
      status.textContent = "";
      status.classList.remove("is-error");
    }
    STATE.editingId = null;
  }

  function beginEdit(id) {
    var post = STATE.posts.find(function (p) {
      return p.id === id;
    });
    if (!post) return;
    STATE.editingId = id;
    el("news-edit-id").value = id;
    el("news-title").value = post.title || "";
    el("news-summary").value = post.summary || "";
    el("news-body").value = post.body || "";
    el("news-category").value = post.category || "update";
    el("news-version").value = post.version || "";
    el("news-pinned").checked = !!post.pinned;
    el("news-published").checked = !!post.published;
    el("news-composer-title").textContent = "Edit post";
    el("news-submit").textContent = "Save changes";
    el("news-cancel").hidden = false;
    var card = el("news-composer-card");
    if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function bindListActions() {
    var list = el("news-list");
    if (!list) return;
    list.addEventListener("click", function (e) {
      var editBtn = e.target.closest && e.target.closest("[data-news-edit]");
      if (editBtn) {
        beginEdit(editBtn.getAttribute("data-news-edit"));
        return;
      }
      var delBtn = e.target.closest && e.target.closest("[data-news-del]");
      if (delBtn) {
        var id = delBtn.getAttribute("data-news-del");
        var post =
          STATE.posts.find(function (p) {
            return p.id === id;
          }) || {};
        var ok = window.confirm(
          'Delete "' + (post.title || "this post") + '"? This cannot be undone.'
        );
        if (!ok) return;
        delBtn.disabled = true;
        window.GarudaApi
          .adminDeleteNews(id)
          .then(fetchNews)
          .catch(function (err) {
            delBtn.disabled = false;
            alert("Could not delete: " + ((err && err.message) || "error"));
          });
      }
    });
  }

  function bindFilter() {
    var sel = el("news-filter");
    if (!sel) return;
    sel.addEventListener("change", function () {
      STATE.filter = sel.value || "";
      render();
    });
  }

  function bindLogout() {
    var btn = document.getElementById("nav-logout");
    if (!btn || !window.GarudaAuth) return;
    btn.addEventListener("click", function () {
      window.GarudaAuth.logout().then(function () {
        window.location.href = "index.html";
      });
    });
  }

  function showComposerIfAdmin() {
    if (!STATE.isAdmin) return;
    var card = el("news-composer-card");
    if (card) card.hidden = false;
    var newBtn = el("news-new-post");
    if (newBtn) newBtn.hidden = false;
    var logout = document.getElementById("nav-logout");
    if (logout) logout.hidden = false;
  }

  function init() {
    bindComposer();
    bindListActions();
    bindFilter();
    bindLogout();

    var authReady =
      window.GarudaAuth && window.GarudaAuth.ready
        ? window.GarudaAuth.ready()
        : Promise.resolve(null);

    authReady
      .then(function (user) {
        STATE.viewer = user || null;
        STATE.isAdmin = !!(user && user.role === "admin");
        showComposerIfAdmin();
        return fetchNews();
      })
      .catch(function () {
        return fetchNews();
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
