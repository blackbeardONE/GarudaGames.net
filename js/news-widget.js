/**
 * Dashboard "Latest news" preview widget.
 *
 * Auto-attaches to every element with [data-news-widget] on the page, pulls
 * the most recent posts from /api/news, and renders a compact card list
 * with a "See all updates" link to news.html.
 *
 * The limit is controlled by the `data-limit` attribute (default 3).
 * Works on public pages too; no auth required.
 */
(function () {
  if (!window.GarudaApi || !window.GarudaApi.listNews) return;

  var NEWS_LAST_SEEN_KEY = "garuda:newsLastSeenAt";

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
      : d.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
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

  function renderPost(post) {
    var cat = (post.category || "update").toLowerCase();
    var isNew = false;
    try {
      var seen = parseInt(
        localStorage.getItem(NEWS_LAST_SEEN_KEY) || "0",
        10
      );
      isNew = !seen || (post.createdAt || 0) > seen;
    } catch (_) {
      /* storage disabled */
    }
    return (
      '<li class="news-widget__item news-widget__item--' +
      escapeHtml(cat) +
      (post.pinned ? " news-widget__item--pinned" : "") +
      '">' +
      '<a class="news-widget__link" href="news.html">' +
      '<span class="news-widget__kind news-widget__kind--' +
      escapeHtml(cat) +
      '">' +
      escapeHtml(categoryLabel(cat)) +
      "</span>" +
      (isNew
        ? '<span class="news-widget__new" aria-label="New post">NEW</span>'
        : "") +
      '<span class="news-widget__title">' +
      escapeHtml(post.title || "") +
      "</span>" +
      '<time class="news-widget__time" datetime="' +
      new Date(post.createdAt || Date.now()).toISOString() +
      '">' +
      escapeHtml(formatWhen(post.createdAt)) +
      "</time>" +
      '<span class="news-widget__summary">' +
      escapeHtml(post.summary || "") +
      "</span>" +
      "</a>" +
      "</li>"
    );
  }

  function mount(root) {
    var limit = parseInt(root.getAttribute("data-limit"), 10) || 3;
    root.classList.add("news-widget");

    root.innerHTML =
      '<p class="news-widget__loading">Loading latest updates…</p>';

    window.GarudaApi
      .listNews({ limit: limit })
      .then(function (res) {
        var posts = (res && res.news) || [];
        if (!posts.length) {
          root.innerHTML =
            '<p class="news-widget__empty">No posts yet. We\'ll share club updates here as soon as they\'re ready.</p>' +
            '<p class="news-widget__footer"><a class="news-widget__more" href="news.html">Open the News page →</a></p>';
          return;
        }
        root.innerHTML =
          '<ul class="news-widget__list">' +
          posts.map(renderPost).join("") +
          "</ul>" +
          '<p class="news-widget__footer"><a class="news-widget__more" href="news.html">See all updates →</a></p>';
      })
      .catch(function (err) {
        root.innerHTML =
          '<p class="news-widget__empty">Could not load news right now (' +
          escapeHtml((err && err.message) || "error") +
          "). " +
          '<a class="news-widget__more" href="news.html">Open the News page →</a>' +
          "</p>";
      });
  }

  function init() {
    var nodes = document.querySelectorAll("[data-news-widget]");
    for (var i = 0; i < nodes.length; i++) mount(nodes[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
