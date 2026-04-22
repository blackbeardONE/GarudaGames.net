/**
 * Apply admin-customized site copy on the public pages.
 */
(function () {
  if (!window.GarudaApi) return;

  function applySite(c) {
    if (!c) return;
    var extra = document.getElementById("site-footer-custom-note");
    if (extra && c.footerNote) {
      extra.textContent = " · " + c.footerNote;
    }
    var tagline = document.getElementById("site-tagline");
    if (tagline && c.headerTagline) {
      tagline.textContent = c.headerTagline;
      tagline.hidden = false;
    }
    var hc = document.getElementById("org-head-captain");
    if (hc && c.headCaptain) hc.textContent = c.headCaptain;
    var org = document.getElementById("org-chart-custom");
    if (org && c.orgChartHtml) {
      org.innerHTML = c.orgChartHtml;
    }
    var brand = document.querySelector(".brand__mark");
    if (brand && c.brandMarkDataUrl) {
      brand.src = c.brandMarkDataUrl;
    }
    if (Array.isArray(c.extraNav) && c.extraNav.length) {
      var navWrap = document.getElementById("site-nav");
      if (navWrap) {
        c.extraNav.forEach(function (item) {
          if (!item || !item.href || !item.label) return;
          var a = document.createElement("a");
          a.href = item.href;
          a.textContent = item.label;
          if (item.external) {
            a.target = "_blank";
            a.rel = "noopener noreferrer";
          }
          navWrap.appendChild(a);
        });
      }
    }
  }

  window.GarudaApi
    .getSite()
    .then(function (res) {
      applySite(res && res.site);
    })
    .catch(function () {});
})();
