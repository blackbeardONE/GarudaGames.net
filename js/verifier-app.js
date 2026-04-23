(function () {
  if (!window.GarudaAuth || !window.GarudaApi) return;

  function el(id) {
    return document.getElementById(id);
  }
  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  // Local-timezone YYYY-MM-DD. Used to cap the <input type="date"> `max` so
  // a verifier in UTC+08 can still pick "today" without a UTC shift rolling
  // it into tomorrow.
  function todayIsoLocal() {
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  // Display a submission row's member as "<clubTag> <ign>" when we have an
  // IGN, falling back to the username so unmatched records still render.
  function bladerName(row) {
    if (!row) return "";
    var name = row.ign || row.username || "";
    if (
      window.GarudaSite &&
      typeof window.GarudaSite.formatBladerName === "function"
    ) {
      return window.GarudaSite.formatBladerName(name);
    }
    return name;
  }

  var CURRENT_USER = null;
  var ACH_TAB = "pending";
  var JLAP_TAB = "pending";

  window.GarudaAuth
    .requireRoleOrRedirect("verifier", "dashboard.html")
    .then(function (user) {
      if (!user) return;
      CURRENT_USER = user;
      var navAdmin = el("nav-admin-verif");
      if (navAdmin) navAdmin.hidden = user.role !== "admin";
      bindLogout();
      // v1.19.0 — pre-gate: staff without TOTP past the grace window
      // gets a page-level block instead of a cascade of 403s. The gate
      // replaces the main content, so the tabs/lightbox binding below
      // wouldn't have anywhere to attach anyway.
      var host = document.querySelector("main") || document.body;
      if (
        window.GarudaStaff2faGate &&
        window.GarudaStaff2faGate.renderHardGate(user, host)
      ) {
        return;
      }
      bindTabs();
      bindLightbox();
      renderAll();
    });

  function bindLightbox() {
    var lb = el("verif-lightbox");
    if (!lb) return;
    function close() {
      lb.setAttribute("hidden", "");
      document.body.classList.remove("verif-lightbox-open");
      var img = el("verif-lightbox-img");
      if (img) img.src = "";
    }
    lb.addEventListener("click", function (e) {
      if (e.target && e.target.hasAttribute("data-lightbox-close")) {
        close();
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !lb.hasAttribute("hidden")) close();
    });
  }

  function openLightbox(url, title) {
    var lb = el("verif-lightbox");
    var img = el("verif-lightbox-img");
    var open = el("verif-lightbox-open");
    var ttl = el("verif-lightbox-title");
    if (!lb || !img || !url) return;
    img.src = url;
    img.alt = title || "Preview";
    if (ttl) ttl.textContent = title || "Preview";
    if (open) open.href = url;
    lb.removeAttribute("hidden");
    document.body.classList.add("verif-lightbox-open");
  }

  // Previews now lazy-load: list endpoints only indicate whether an asset
  // exists (hasPoster / hasCertificate / hasQr) to keep queue responses
  // small, and the full data URL is fetched when the link is clicked.
  function previewLink(text, loader, title) {
    var a = document.createElement("a");
    a.href = "#";
    a.rel = "noopener";
    a.textContent = text;
    a.className = "verif-preview-link";
    a.addEventListener("click", function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      var original = a.textContent;
      a.textContent = "Loading?";
      a.classList.add("is-loading");
      Promise.resolve(loader())
        .then(function (url) {
          if (!url) throw new Error("No asset attached.");
          openLightbox(url, title || original);
        })
        .catch(function (err) {
          alert((err && err.message) || "Could not load preview.");
        })
        .then(function () {
          a.textContent = original;
          a.classList.remove("is-loading");
        });
    });
    return a;
  }

  // v1.23.0 — resolve either the blob URL (/api/blob/<sha>) or the
  // legacy inline data URL. The browser renders both the same way in
  // an <img src>, so the caller doesn't need to know which one it got.
  function loadAchievementPoster(id) {
    return window.GarudaApi.getAchievement(id).then(function (res) {
      var a = res && res.achievement;
      return (a && (a.posterUrl || a.posterDataUrl)) || "";
    });
  }
  function loadJlapCertificate(id) {
    return window.GarudaApi.getJlap(id).then(function (res) {
      var j = res && res.jlap;
      return (j && (j.certificateUrl || j.certificateDataUrl)) || "";
    });
  }
  function loadJlapQr(id) {
    return window.GarudaApi.getJlap(id).then(function (res) {
      var j = res && res.jlap;
      return (j && (j.qrUrl || j.qrDataUrl)) || "";
    });
  }

  function bindTabs() {
    var aTabs = el("verif-ach-tabs");
    var jTabs = el("verif-jlap-tabs");
    function hook(root, setter) {
      if (!root) return;
      root.addEventListener("click", function (e) {
        var t = e.target;
        if (!t || t.tagName !== "BUTTON") return;
        var btns = root.querySelectorAll("button");
        for (var i = 0; i < btns.length; i++) {
          btns[i].classList.remove("chip--active");
          btns[i].setAttribute("aria-selected", "false");
        }
        t.classList.add("chip--active");
        t.setAttribute("aria-selected", "true");
        setter(t.dataset.status || "pending");
      });
    }
    hook(aTabs, function (s) {
      ACH_TAB = s;
      renderAch();
    });
    hook(jTabs, function (s) {
      JLAP_TAB = s;
      renderJlap();
    });
  }

  function renderAll() {
    return Promise.all([
      renderAch(),
      renderIdFlags(),
      renderJlap(),
      renderAppeals(),
    ]).then(renderOverview);
  }

  // v1.24.0 — pending appeals queue (achievements + JLAP + ID flags).
  function renderAppeals() {
    var tbody = el("verif-appeals-tbody");
    if (!tbody) return Promise.resolve();
    tbody.innerHTML =
      '<tr><td colspan="6" class="dash-table-empty">Loading…</td></tr>';
    var badge = el("vstat-pend-appeals");
    return window.GarudaApi
      .listPendingAppeals()
      .then(function (res) {
        var rows = [];
        (res.achievements || []).forEach(function (r) {
          rows.push({
            kind: "achievement",
            when: r.appealSubmittedAt,
            typeLabel: "Achievement",
            member: bladerName(r),
            detail:
              r.eventName +
              " · " +
              r.rank +
              (r.eventDate ? " (" + r.eventDate + ")" : ""),
            verifierNote: r.verifierNote || "",
            appealText: r.appealText,
            id: r.id,
          });
        });
        (res.jlap || []).forEach(function (r) {
          rows.push({
            kind: "jlap",
            when: r.appealSubmittedAt,
            typeLabel: "JLAP",
            member: bladerName(r),
            detail: "Certificate + QR",
            verifierNote: r.verifierNote || "",
            appealText: r.appealText,
            id: r.id,
          });
        });
        (res.idFlags || []).forEach(function (r) {
          var parts = [];
          if (r.certifiedJudge) parts.push("Certified Judge");
          (r.proGames || []).forEach(function (g) {
            parts.push(window.ProFlags ? window.ProFlags.label(g) : "PRO " + g);
          });
          rows.push({
            kind: "idflags",
            when: r.appealSubmittedAt,
            typeLabel: "ID flags",
            member: bladerName(r),
            detail: parts.length ? parts.join(", ") : "—",
            verifierNote: r.verifierNote || "",
            appealText: r.appealText,
            id: r.id,
          });
        });
        rows.sort(function (a, b) {
          return (a.when || 0) - (b.when || 0);
        });
        if (badge) badge.textContent = String(rows.length);
        if (!rows.length) {
          tbody.innerHTML =
            '<tr><td colspan="6" class="dash-table-empty">No pending appeals.</td></tr>';
          return;
        }
        tbody.innerHTML = "";
        rows.forEach(function (r) {
          var tr = document.createElement("tr");
          tr.innerHTML =
            "<td>" +
            esc(fmtWhen(r.when)) +
            "</td><td>" +
            esc(r.typeLabel) +
            "</td><td>" +
            esc(r.member) +
            "</td><td>" +
            esc(r.detail) +
            (r.verifierNote
              ? '<br><small class="dash-hint">Rejected: ' +
                esc(r.verifierNote) +
                "</small>"
              : "") +
            '</td><td><pre class="verif-appeal-text">' +
            esc(r.appealText) +
            "</pre></td><td>" +
            '<button type="button" class="btn btn--primary btn--small" data-appeal-accept>Accept</button> ' +
            '<button type="button" class="btn btn--ghost btn--small" data-appeal-deny>Deny</button>' +
            "</td>";
          var accept = tr.querySelector("[data-appeal-accept]");
          var deny = tr.querySelector("[data-appeal-deny]");
          accept.addEventListener("click", function () {
            var note = window.prompt(
              "Optional note to the member on accepting this appeal:",
              ""
            );
            if (note === null) return;
            window.GarudaApi
              .resolveAppeal(r.kind, r.id, "accept", note || "")
              .then(renderAll)
              .catch(function (err) {
                alert((err && err.message) || "Could not accept appeal.");
              });
          });
          deny.addEventListener("click", function () {
            var note = window.prompt(
              "Reason for denying this appeal (shown to the member, required):",
              ""
            );
            if (note === null) return;
            if (!note.trim()) {
              alert("A verifier note is required when denying an appeal.");
              return;
            }
            window.GarudaApi
              .resolveAppeal(r.kind, r.id, "deny", note.trim())
              .then(renderAll)
              .catch(function (err) {
                alert((err && err.message) || "Could not deny appeal.");
              });
          });
          tbody.appendChild(tr);
        });
      })
      .catch(function () {
        tbody.innerHTML =
          '<tr><td colspan="6" class="dash-table-empty">Could not load appeals.</td></tr>';
      });
  }

  function fmtWhen(ts) {
    if (!ts) return "?";
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "?";
    var now = Date.now();
    var diff = now - ts;
    var minute = 60 * 1000;
    var hour = 60 * minute;
    var day = 24 * hour;
    if (diff < minute) return "just now";
    if (diff < hour) return Math.floor(diff / minute) + "m ago";
    if (diff < day) return Math.floor(diff / hour) + "h ago";
    if (diff < 7 * day) return Math.floor(diff / day) + "d ago";
    return d.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
  }

  function renderOverview() {
    var pendAchEl = el("vstat-pend-ach");
    var pendFlagsEl = el("vstat-pend-idflags");
    var pendJlapEl = el("vstat-pend-jlap");
    var mineTotalEl = el("vstat-mine-total");
    var mineBreakdownEl = el("vstat-mine-breakdown");
    var recentTbody = el("vq-recent-tbody");

    var pAch = window.GarudaApi.listAchievements().catch(function () {
      return { achievements: [] };
    });
    var pJlap = window.GarudaApi.listJlap().catch(function () {
      return { jlap: [] };
    });
    var pFlags = window.GarudaApi.pendingIdFlags().catch(function () {
      return { requests: [] };
    });

    Promise.all([pAch, pJlap, pFlags]).then(function (results) {
      var ach = (results[0] && results[0].achievements) || [];
      var jl = (results[1] && results[1].jlap) || [];
      var flagsPending = (results[2] && results[2].requests) || [];
      var me = (CURRENT_USER && CURRENT_USER.username) || "";

      var pendAch = ach.filter(function (r) {
        return r.status === "pending";
      }).length;
      var pendJlap = jl.filter(function (r) {
        return r.status === "pending";
      }).length;

      if (pendAchEl) pendAchEl.textContent = String(pendAch);
      if (pendJlapEl) pendJlapEl.textContent = String(pendJlap);
      if (pendFlagsEl) pendFlagsEl.textContent = String(flagsPending.length);

      var mineAch = ach.filter(function (r) {
        return r.verifiedBy && r.verifiedBy === me;
      });
      var mineJlap = jl.filter(function (r) {
        return r.verifiedBy && r.verifiedBy === me;
      });
      var mineTotal = mineAch.length + mineJlap.length;
      if (mineTotalEl) mineTotalEl.textContent = String(mineTotal);
      if (mineBreakdownEl) {
        mineBreakdownEl.textContent =
          mineAch.length + " achievement ? " + mineJlap.length + " JLAP";
      }

      if (recentTbody) {
        var combined = [];
        mineAch.forEach(function (r) {
          combined.push({
            when: r.verifiedAt || r.createdAt,
            type: "Achievement",
            member: bladerName(r),
            detail: r.eventName + " ? " + r.rank,
            status: r.status
          });
        });
        mineJlap.forEach(function (r) {
          combined.push({
            when: r.verifiedAt || r.createdAt,
            type: "JLAP",
            member: bladerName(r),
            detail: "JLAP certificate",
            status: r.status
          });
        });
        combined.sort(function (a, b) {
          return (b.when || 0) - (a.when || 0);
        });
        combined = combined.slice(0, 5);
        recentTbody.innerHTML = "";
        if (!combined.length) {
          recentTbody.innerHTML =
            '<tr><td colspan="5" class="dash-table-empty">No verifications yet.</td></tr>';
        } else {
          combined.forEach(function (row) {
            var tr = document.createElement("tr");
            var statusClass =
              row.status === "verified"
                ? "pill pill--ok"
                : row.status === "rejected"
                  ? "pill pill--bad"
                  : "pill";
            tr.innerHTML =
              "<td>" +
              esc(fmtWhen(row.when)) +
              "</td><td>" +
              esc(row.type) +
              "</td><td>" +
              esc(row.member) +
              "</td><td>" +
              esc(row.detail) +
              '</td><td><span class="' +
              statusClass +
              '">' +
              esc(row.status) +
              "</span></td>";
            recentTbody.appendChild(tr);
          });
        }
      }
    });
  }

  function renderAch() {
    var tbody = el("verif-ach-tbody");
    if (!tbody) return Promise.resolve();
    tbody.innerHTML =
      '<tr><td colspan="7" class="dash-table-empty">Loading?</td></tr>';
    return window.GarudaApi.listAchievements().then(function (res) {
      tbody.innerHTML = "";
      var all = (res && res.achievements) || [];

      // Keep the overview "Missing dates" counters in sync on every fetch
      // ? both the inline tab pill and the top-level stat card.
      var missingCount = 0;
      for (var mi = 0; mi < all.length; mi++) {
        if (all[mi].status === "verified" && !all[mi].eventDate) missingCount++;
      }
      var countPill = el("verif-missing-date-count");
      if (countPill) {
        countPill.textContent = String(missingCount);
        countPill.hidden = missingCount === 0;
      }
      var statEl = el("vstat-missing-date");
      if (statEl) statEl.textContent = String(missingCount);

      var list;
      if (ACH_TAB === "missing-date") {
        list = all.filter(function (a) {
          return a.status === "verified" && !a.eventDate;
        });
      } else {
        list = all.filter(function (a) {
          return a.status === ACH_TAB;
        });
      }
      if (!list.length) {
        var emptyLabel =
          ACH_TAB === "missing-date"
            ? "Nothing to backfill ? every verified achievement has an event date."
            : "No " + ACH_TAB + " achievements.";
        tbody.innerHTML =
          '<tr><td colspan="7" class="dash-table-empty">' +
          esc(emptyLabel) +
          "</td></tr>";
        return;
      }
      list.sort(function (a, b) {
        if (ACH_TAB === "pending") return a.createdAt - b.createdAt;
        if (ACH_TAB === "missing-date") {
          // Oldest-verified first so the backlog drains head-of-line.
          return (a.verifiedAt || a.createdAt) - (b.verifiedAt || b.createdAt);
        }
        return (
          (b.verifiedAt || b.createdAt) - (a.verifiedAt || a.createdAt)
        );
      });
      list.forEach(function (r) {
        var tr = document.createElement("tr");
        tr.dataset.id = r.id;
        var rankText = r.rank;
        if (r.playerCount) {
          rankText +=
            " (" +
            r.playerCount +
            "p" +
            (r.isGrandTournament ? ", GT" : "") +
            ")";
        }
        tr.innerHTML =
          "<td>" +
          esc(bladerName(r)) +
          "</td><td>" +
          esc(r.eventName) +
          '</td><td class="verif-date"></td><td>' +
          esc(rankText) +
          "</td><td>" +
          r.rankPoints +
          '</td><td class="verif-challonge"></td><td class="verif-actions"></td>';
        var tdCh = tr.querySelector(".verif-challonge");
        if (r.challongeUrl) {
          var cl = document.createElement("a");
          cl.href = r.challongeUrl;
          cl.target = "_blank";
          cl.rel = "noopener noreferrer";
          cl.textContent = "Challonge";
          tdCh.appendChild(cl);
        } else {
          tdCh.textContent = "?";
        }
        // Event date column. Legacy rows (submitted before the required-date
        // feature) have eventDate = "" ? on the Pending tab the verifier has
        // to fill one in before Verify is accepted by the server. On the
        // Missing-dates tab the row is already verified, so we offer an
        // inline date input that backfills the date without changing status.
        var tdDate = tr.querySelector(".verif-date");
        var dateInput = null;
        if (r.eventDate && ACH_TAB !== "missing-date") {
          tdDate.textContent = r.eventDate;
        } else if (ACH_TAB === "pending" || ACH_TAB === "missing-date") {
          dateInput = document.createElement("input");
          dateInput.type = "date";
          dateInput.className = "verif-date-input";
          dateInput.required = true;
          dateInput.max = todayIsoLocal();
          dateInput.min = "2000-01-01";
          dateInput.value = r.eventDate || "";
          dateInput.title = "Required: enter the date this event was held";
          var hint = document.createElement("span");
          hint.className = "verif-date-hint";
          hint.textContent =
            ACH_TAB === "missing-date"
              ? "Set the date this event was held"
              : "Required to approve";
          tdDate.appendChild(dateInput);
          tdDate.appendChild(hint);
        } else {
          tdDate.textContent = "?";
        }

        var td = tr.querySelector(".verif-actions");
        if (r.hasPoster) {
          (function (rowId, blader, eventName) {
            td.appendChild(
              previewLink(
                "View poster",
                function () {
                  return loadAchievementPoster(rowId);
                },
                blader + " - " + eventName
              )
            );
          })(r.id, bladerName(r), r.eventName);
        }
        if (ACH_TAB === "missing-date") {
          (function (rowId, input) {
            var btnSave = document.createElement("button");
            btnSave.type = "button";
            btnSave.className = "btn btn--primary btn--sm";
            btnSave.textContent = "Save date";
            btnSave.addEventListener("click", function () {
              var v = input ? input.value : "";
              if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
                alert("Please pick a valid event date.");
                if (input) input.focus();
                return;
              }
              if (v > todayIsoLocal()) {
                alert("Event date cannot be in the future.");
                if (input) input.focus();
                return;
              }
              btnSave.disabled = true;
              btnSave.textContent = "Saving?";
              window.GarudaApi
                .backfillAchievementDate(rowId, v)
                .then(renderAll)
                .catch(function (err) {
                  alert((err && err.message) || "Could not save the date.");
                  btnSave.disabled = false;
                  btnSave.textContent = "Save date";
                });
            });
            td.appendChild(btnSave);
          })(r.id, dateInput);
        } else if (ACH_TAB === "pending") {
          var ta = document.createElement("textarea");
          ta.rows = 2;
          ta.placeholder = "Note (required for reject)";
          ta.className = "verif-note";
          var btnOk = document.createElement("button");
          btnOk.type = "button";
          btnOk.className = "btn btn--primary btn--sm";
          btnOk.textContent = "Verify";
          btnOk.addEventListener("click", function () {
            var patch = {
              status: "verified",
              verifierNote: ta.value.trim()
            };
            if (dateInput) {
              var v = dateInput.value;
              if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
                alert(
                  "Please fill in the date of the event before approving."
                );
                dateInput.focus();
                return;
              }
              if (v > todayIsoLocal()) {
                alert("Event date cannot be in the future.");
                dateInput.focus();
                return;
              }
              patch.eventDate = v;
            }
            btnOk.disabled = true;
            window.GarudaApi
              .reviewAchievement(r.id, patch)
              .then(renderAll)
              .catch(function (err) {
                alert((err && err.message) || "Could not verify.");
                btnOk.disabled = false;
              });
          });
          var btnNo = document.createElement("button");
          btnNo.type = "button";
          btnNo.className = "btn btn--ghost btn--sm";
          btnNo.textContent = "Reject";
          btnNo.addEventListener("click", function () {
            var note = ta.value.trim();
            if (!note) {
              alert("Add a note for the member when rejecting.");
              return;
            }
            btnNo.disabled = true;
            window.GarudaApi
              .reviewAchievement(r.id, {
                status: "rejected",
                verifierNote: note
              })
              .then(renderAll)
              .catch(function (err) {
                alert((err && err.message) || "Could not reject.");
                btnNo.disabled = false;
              });
          });
          td.appendChild(ta);
          td.appendChild(btnOk);
          td.appendChild(btnNo);
        } else {
          var info = document.createElement("span");
          info.className = "verif-history-meta";
          info.textContent =
            (r.verifiedBy ? "by " + r.verifiedBy + " ? " : "") +
            fmtWhen(r.verifiedAt || r.createdAt) +
            (r.verifierNote ? " ? " + r.verifierNote : "");
          td.appendChild(info);
        }
        tbody.appendChild(tr);
      });
    });
  }

  function renderIdFlags() {
    var tbody = el("verif-idflags-tbody");
    if (!tbody) return Promise.resolve();
    tbody.innerHTML =
      '<tr><td colspan="3" class="dash-table-empty">Loading?</td></tr>';
    return window.GarudaApi.pendingIdFlags().then(function (res) {
      tbody.innerHTML = "";
      var list = (res && res.requests) || [];
      if (!list.length) {
        tbody.innerHTML =
          '<tr><td colspan="3" class="dash-table-empty">No pending ID flag requests.</td></tr>';
        return;
      }
      list.forEach(function (r) {
        var parts = [];
        if (r.certifiedJudge) parts.push("Certified Judge");
        var proGames =
          (window.ProFlags && window.ProFlags.normalize(r.proGames)) ||
          (r.professionalBlader ? ["Beyblade X"] : []);
        proGames.forEach(function (g) {
          parts.push(window.ProFlags ? window.ProFlags.label(g) : "PRO " + g);
        });
        var reqText = parts.length ? parts.join(", ") : "None (clear flags)";
        var tr = document.createElement("tr");
        tr.dataset.id = r.id;
        var tdAct = document.createElement("td");
        tdAct.className = "verif-actions";
        var ta = document.createElement("textarea");
        ta.rows = 2;
        ta.placeholder = "Note (required for reject)";
        ta.className = "verif-note";
        var btnOk = document.createElement("button");
        btnOk.type = "button";
        btnOk.className = "btn btn--primary btn--sm";
        btnOk.textContent = "Approve";
        btnOk.addEventListener("click", function () {
          btnOk.disabled = true;
          window.GarudaApi
            .reviewIdFlags(r.id, {
              status: "verified",
              verifierNote: ta.value.trim()
            })
            .then(renderAll)
            .catch(function (err) {
              alert((err && err.message) || "Could not approve.");
              btnOk.disabled = false;
            });
        });
        var btnNo = document.createElement("button");
        btnNo.type = "button";
        btnNo.className = "btn btn--ghost btn--sm";
        btnNo.textContent = "Reject";
        btnNo.addEventListener("click", function () {
          var note = ta.value.trim();
          if (!note) {
            alert("Add a note when rejecting.");
            return;
          }
          btnNo.disabled = true;
          window.GarudaApi
            .reviewIdFlags(r.id, {
              status: "rejected",
              verifierNote: note
            })
            .then(renderAll)
            .catch(function (err) {
              alert((err && err.message) || "Could not reject.");
              btnNo.disabled = false;
            });
        });
        tdAct.appendChild(ta);
        tdAct.appendChild(btnOk);
        tdAct.appendChild(btnNo);
        var tdU = document.createElement("td");
        tdU.textContent = bladerName(r);
        var tdReq = document.createElement("td");

        // Summary line + per-game evidence panel (v1.14.0). Evidence
        // arrives in slim form on the queue; photos are lazy-loaded per
        // click via GET /api/id-flags/:id so the queue stays light.
        var summary = document.createElement("div");
        summary.textContent = reqText;
        tdReq.appendChild(summary);

        var evidence = Array.isArray(r.evidence) ? r.evidence : [];
        if (evidence.length) {
          var panel = document.createElement("div");
          panel.className = "verif-idflag-evidence";
          evidence.forEach(function (ev) {
            var item = document.createElement("div");
            item.className = "verif-idflag-evidence__item";
            var title = document.createElement("div");
            var label = window.ProFlags
              ? window.ProFlags.label(ev.game)
              : "PRO " + ev.game;
            title.textContent = label;
            if (ev.league) {
              var badge = document.createElement("span");
              badge.className = "verif-idflag-evidence__badge";
              badge.textContent =
                ev.league +
                (ev.leagueLabel ? " — " + ev.leagueLabel : "");
              title.appendChild(badge);
            }
            item.appendChild(title);
            if (ev.linkUrl) {
              var linkLine = document.createElement("div");
              var a = document.createElement("a");
              a.href = ev.linkUrl;
              a.target = "_blank";
              a.rel = "noopener noreferrer";
              a.className = "verif-idflag-evidence__link";
              a.textContent = ev.linkUrl;
              linkLine.appendChild(a);
              item.appendChild(linkLine);
            }
            if (ev.hasPhoto) {
              (function (reqId, game) {
                item.appendChild(
                  previewLink(
                    "View photo",
                    function () {
                      return window.GarudaApi
                        .getIdFlag(reqId)
                        .then(function (resp) {
                          var list =
                            (resp && resp.request && resp.request.evidence) || [];
                          var match = list.filter(function (e) {
                            return e.game === game && (e.photoUrl || e.photoDataUrl);
                          })[0];
                          return match ? (match.photoUrl || match.photoDataUrl) : "";
                        });
                    },
                    bladerName(r) + " — " + label
                  )
                );
              })(r.id, ev.game);
            }
            if (ev.note) {
              var noteLine = document.createElement("div");
              noteLine.textContent = "Note: " + ev.note;
              item.appendChild(noteLine);
            }
            if (!ev.linkUrl && !ev.hasPhoto) {
              var warnLine = document.createElement("div");
              warnLine.textContent = "(no photo or link attached)";
              item.appendChild(warnLine);
            }
            panel.appendChild(item);
          });
          tdReq.appendChild(panel);
        }

        tr.appendChild(tdU);
        tr.appendChild(tdReq);
        tr.appendChild(tdAct);
        tbody.appendChild(tr);
      });
    });
  }

  function renderJlap() {
    var tbody = el("verif-jlap-tbody");
    if (!tbody) return Promise.resolve();
    tbody.innerHTML =
      '<tr><td colspan="4" class="dash-table-empty">Loading?</td></tr>';
    return window.GarudaApi.listJlap().then(function (res) {
      tbody.innerHTML = "";
      var list = (res && res.jlap) || [];
      list = list.filter(function (a) {
        return a.status === JLAP_TAB;
      });
      if (!list.length) {
        tbody.innerHTML =
          '<tr><td colspan="4" class="dash-table-empty">No ' +
          JLAP_TAB +
          " JLAP submissions.</td></tr>";
        return;
      }
      list.sort(function (a, b) {
        return JLAP_TAB === "pending"
          ? a.createdAt - b.createdAt
          : (b.verifiedAt || b.createdAt) - (a.verifiedAt || a.createdAt);
      });
      list.forEach(function (r) {
        var tr = document.createElement("tr");
        tr.dataset.id = r.id;
        var tdAct = document.createElement("td");
        tdAct.className = "verif-actions";
        if (JLAP_TAB === "pending") {
          var ta = document.createElement("textarea");
          ta.rows = 2;
          ta.placeholder = "Note";
          ta.className = "verif-note";
          // v1.17.0: optional expiry picker. Default is blank ("indefinite")
          // to match pre-v1.17.0 behaviour; most approvals will want the
          // Renew-next-year default so we pre-fill with +365d when the
          // verifier ticks the checkbox.
          var expLabel = document.createElement("label");
          expLabel.className = "verif-jlap-exp";
          expLabel.innerHTML =
            '<input type="checkbox" class="verif-jlap-exp-enable" /> ' +
            '<span>Expires</span> ' +
            '<input type="date" class="verif-jlap-exp-date" disabled />';
          var expEnable = expLabel.querySelector(".verif-jlap-exp-enable");
          var expDate = expLabel.querySelector(".verif-jlap-exp-date");
          expEnable.addEventListener("change", function () {
            expDate.disabled = !expEnable.checked;
            if (expEnable.checked && !expDate.value) {
              var d = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
              expDate.value = d.toISOString().slice(0, 10);
            }
          });
          var btnOk = document.createElement("button");
          btnOk.type = "button";
          btnOk.className = "btn btn--primary btn--sm";
          btnOk.textContent = "Verify";
          btnOk.addEventListener("click", function () {
            btnOk.disabled = true;
            var payload = {
              status: "verified",
              verifierNote: ta.value.trim()
            };
            if (expEnable.checked && expDate.value) {
              payload.expiresAt = expDate.value;
            }
            window.GarudaApi
              .reviewJlap(r.id, payload)
              .then(renderAll)
              .catch(function (err) {
                alert((err && err.message) || "Could not verify.");
                btnOk.disabled = false;
              });
          });
          var btnNo = document.createElement("button");
          btnNo.type = "button";
          btnNo.className = "btn btn--ghost btn--sm";
          btnNo.textContent = "Reject";
          btnNo.addEventListener("click", function () {
            var note = ta.value.trim();
            if (!note) {
              alert("Add a note when rejecting.");
              return;
            }
            btnNo.disabled = true;
            window.GarudaApi
              .reviewJlap(r.id, {
                status: "rejected",
                verifierNote: note
              })
              .then(renderAll)
              .catch(function (err) {
                alert((err && err.message) || "Could not reject.");
                btnNo.disabled = false;
              });
          });
          tdAct.appendChild(ta);
          tdAct.appendChild(expLabel);
          tdAct.appendChild(btnOk);
          tdAct.appendChild(btnNo);
        } else {
          var info = document.createElement("span");
          info.className = "verif-history-meta";
          var expStr = "";
          if (r.expiresAt) {
            var expDateObj = new Date(r.expiresAt);
            expStr = " - expires " + expDateObj.toISOString().slice(0, 10) +
              (r.expiresAt <= Date.now() ? " (EXPIRED)" : "");
          }
          info.textContent =
            (r.verifiedBy ? "by " + r.verifiedBy + " - " : "") +
            fmtWhen(r.verifiedAt || r.createdAt) +
            (r.verifierNote ? " - " + r.verifierNote : "") +
            expStr;
          tdAct.appendChild(info);
        }
        var tdU = document.createElement("td");
        tdU.textContent = bladerName(r);
        var tdC = document.createElement("td");
        if (r.hasCertificate) {
          (function (rowId, blader) {
            tdC.appendChild(
              previewLink(
                "Certificate",
                function () {
                  return loadJlapCertificate(rowId);
                },
                blader + " - JLAP certificate"
              )
            );
          })(r.id, bladerName(r));
        } else {
          tdC.textContent = "-";
        }
        var tdQ = document.createElement("td");
        if (r.hasQr) {
          (function (rowId, blader) {
            tdQ.appendChild(
              previewLink(
                "QR",
                function () {
                  return loadJlapQr(rowId);
                },
                blader + " - JLAP QR"
              )
            );
          })(r.id, bladerName(r));
        } else {
          tdQ.textContent = "-";
        }
        tr.appendChild(tdU);
        tr.appendChild(tdC);
        tr.appendChild(tdQ);
        tr.appendChild(tdAct);
        tbody.appendChild(tr);
      });
    });
  }

  function bindLogout() {
    var navOut = el("nav-logout");
    if (navOut) {
      navOut.addEventListener("click", function () {
        window.GarudaAuth.logout();
      });
    }
  }
})();
