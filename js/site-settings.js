/**
 * Shared site-setting bootstrap.
 *
 * Publishes window.GarudaSite with the club tag prefix used to build
 * blader display names (clan tag + IGN) on members.html, the dashboard
 * profile/Digital ID, and the leaderboard. Admins edit the tag under
 * "Site settings" in the admin dashboard.
 *
 * The default tag is seeded synchronously so the first render does not
 * flicker bare IGNs; the fetched value takes over a moment later and
 * any still-mounted surfaces can opt into re-rendering via the
 * `garuda-site-ready` event.
 */
(function () {
  var DEFAULT_CLUB_TAG = "GRD|TAS";

  function formatBladerName(ign) {
    var name = String(ign == null ? "" : ign).trim();
    if (!name) return "";
    var tag = window.GarudaSite && window.GarudaSite.clubTag;
    if (!tag) return name;
    // Avoid double-prefixing when the IGN already starts with the tag.
    // Case-insensitive match so legacy entries like "grd|tas name" clean up.
    var low = name.toLowerCase();
    var tagLow = tag.toLowerCase();
    if (
      low === tagLow ||
      low.indexOf(tagLow + " ") === 0 ||
      low.indexOf(tagLow + "\u00a0") === 0
    ) {
      // Strip the existing prefix and re-apply canonical casing.
      name = name.slice(tag.length).replace(/^[\s\u00a0]+/, "");
      if (!name) return tag;
    }
    return tag + " " + name;
  }

  var resolveReady;
  var ready = new Promise(function (resolve) {
    resolveReady = resolve;
  });

  window.GarudaSite = {
    clubTag: DEFAULT_CLUB_TAG,
    formatBladerName: formatBladerName,
    ready: ready,
  };

  if (!window.GarudaApi || typeof window.GarudaApi.getSite !== "function") {
    resolveReady(window.GarudaSite);
    return;
  }

  window.GarudaApi
    .getSite()
    .then(function (res) {
      var site = (res && res.site) || {};
      if (typeof site.clubTag === "string") {
        // Empty string explicitly means "no prefix" — respect it.
        window.GarudaSite.clubTag = site.clubTag;
      }
      window.GarudaSite.site = site;
    })
    .catch(function () {
      // Keep the default tag if the server isn't reachable.
    })
    .then(function () {
      resolveReady(window.GarudaSite);
      try {
        document.dispatchEvent(
          new CustomEvent("garuda-site-ready", {
            detail: { clubTag: window.GarudaSite.clubTag },
          })
        );
      } catch (_) {
        /* Older browsers without CustomEvent — ignore; callers can rely on ready. */
      }
    });
})();
