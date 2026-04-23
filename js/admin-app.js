(function () {
  if (!window.GarudaAuth || !window.GarudaApi || !window.GarudaImageUtils)
    return;

  function el(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  var MEMBERS_CACHE = [];
  var PAGE_INDEX = 0;
  var PAGE_SIZE = 25;
  var SEARCH_TERM = "";
  var ROLE_FILTER = "";
  var SORT_KEY = "username";
  var SORT_DIR = 1; // 1 asc, -1 desc

  window.GarudaAuth
    .requireRoleOrRedirect("admin", "dashboard.html")
    .then(function (user) {
      if (!user) return;
      // v1.19.0 — pre-gate: admin without TOTP past the grace window
      // gets a page-level block instead of a cascade of 403s on every
      // widget below. The gate replaces the <main>, so nothing else
      // renders when it fires.
      var host = document.querySelector("main") || document.body;
      if (
        window.GarudaStaff2faGate &&
        window.GarudaStaff2faGate.renderHardGate(user, host)
      ) {
        return;
      }
      renderOverview();
      renderMembers();
      renderStaff2fa();
      loadSiteForm();
      bindAddMember();
      bindSaveSite();
      bindBrandUpload();
      bindExport();
      bindLogout();
      bindPager();
      bindProfileModal();
      bindRoleChips();
      bindCsvExport();
      bindColumnSort();
      bindAuditPanel();
    });

  function fmtDate(ts) {
    if (!ts) return "—";
    var d = new Date(ts);
    return isNaN(d.getTime())
      ? "—"
      : d.toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "2-digit"
        });
  }

  function renderOverview() {
    var statTotal = el("stat-total-members");
    var statBreakdown = el("stat-members-breakdown");
    var statPending = el("stat-pending-total");
    var statPendingBreakdown = el("stat-pending-breakdown");
    var statVerified = el("stat-verified-total");
    var statVerifiedBreakdown = el("stat-verified-breakdown");
    var statPoints = el("stat-points-total");
    var topTbody = el("adm-top-tbody");
    var recentTbody = el("adm-recent-tbody");

    var pMembers = window.GarudaApi.adminMembers().catch(function () {
      return { members: [] };
    });
    var pAch = window.GarudaApi.listAchievements().catch(function () {
      return { achievements: [] };
    });
    var pJlap = window.GarudaApi.listJlap().catch(function () {
      return { jlap: [] };
    });
    var pFlags = window.GarudaApi.pendingIdFlags().catch(function () {
      return { requests: [] };
    });

    Promise.all([pMembers, pAch, pJlap, pFlags]).then(function (results) {
      var members = (results[0] && results[0].members) || [];
      var achievements = (results[1] && results[1].achievements) || [];
      var jlap = (results[2] && results[2].jlap) || [];
      var pendingFlags = (results[3] && results[3].requests) || [];

      var roleCounts = { admin: 0, verifier: 0, user: 0 };
      var totalPoints = 0;
      members.forEach(function (m) {
        if (roleCounts[m.role] !== undefined) roleCounts[m.role] += 1;
        totalPoints += Number(m.points) || 0;
      });

      function byStatus(list, status) {
        return list.filter(function (r) {
          return r.status === status;
        }).length;
      }
      var pendAch = byStatus(achievements, "pending");
      var pendJlap = byStatus(jlap, "pending");
      var pendFlags = pendingFlags.length;
      var verAch = byStatus(achievements, "verified");
      var verJlap = byStatus(jlap, "verified");

      if (statTotal) statTotal.textContent = String(members.length);
      if (statBreakdown) {
        statBreakdown.textContent =
          roleCounts.admin +
          " admin · " +
          roleCounts.verifier +
          " verifier · " +
          roleCounts.user +
          " user";
      }

      if (statPending) statPending.textContent = String(pendAch + pendJlap + pendFlags);
      if (statPendingBreakdown) {
        statPendingBreakdown.textContent =
          pendAch +
          " achievement · " +
          pendJlap +
          " JLAP · " +
          pendFlags +
          " ID flag";
      }

      if (statVerified) statVerified.textContent = String(verAch + verJlap);
      if (statVerifiedBreakdown) {
        statVerifiedBreakdown.textContent =
          verAch + " achievement · " + verJlap + " JLAP";
      }

      if (statPoints) statPoints.textContent = String(totalPoints);

      if (topTbody) {
        var top = members
          .slice()
          .sort(function (a, b) {
            return (b.points || 0) - (a.points || 0);
          })
          .slice(0, 5);
        topTbody.innerHTML = "";
        if (!top.length) {
          topTbody.innerHTML =
            '<tr><td colspan="5" class="dash-table-empty">No members yet.</td></tr>';
        } else {
          top.forEach(function (m, i) {
            var tr = document.createElement("tr");
            tr.innerHTML =
              "<td>" +
              (i + 1) +
              "</td><td>" +
              esc(m.username) +
              "</td><td>" +
              esc(m.ign || "") +
              "</td><td>" +
              esc(m.role) +
              "</td><td>" +
              (Number(m.points) || 0) +
              "</td>";
            topTbody.appendChild(tr);
          });
        }
      }

      if (recentTbody) {
        var recent = members
          .slice()
          .sort(function (a, b) {
            return (b.createdAt || 0) - (a.createdAt || 0);
          })
          .slice(0, 5);
        recentTbody.innerHTML = "";
        if (!recent.length) {
          recentTbody.innerHTML =
            '<tr><td colspan="3" class="dash-table-empty">No members yet.</td></tr>';
        } else {
          recent.forEach(function (m) {
            var tr = document.createElement("tr");
            tr.innerHTML =
              "<td>" +
              esc(m.username) +
              "</td><td>" +
              esc(m.role) +
              "</td><td>" +
              esc(fmtDate(m.createdAt)) +
              "</td>";
            recentTbody.appendChild(tr);
          });
        }
      }
    });
  }

  function renderMembers() {
    var tbody = el("admin-members-tbody");
    if (!tbody) return;
    tbody.innerHTML =
      '<tr><td colspan="5" class="dash-table-empty">Loading…</td></tr>';
    window.GarudaApi
      .adminMembers()
      .then(function (res) {
        MEMBERS_CACHE = (res && res.members) || [];
        PAGE_INDEX = 0;
        renderMembersPage();
      })
      .catch(function (err) {
        tbody.innerHTML =
          '<tr><td colspan="5" class="dash-table-empty">' +
          esc((err && err.message) || "Could not load members.") +
          "</td></tr>";
      });
  }

  function sortMembers(list) {
    var key = SORT_KEY;
    var dir = SORT_DIR;
    return list.slice().sort(function (a, b) {
      var av = a[key];
      var bv = b[key];
      if (key === "points") {
        return ((Number(av) || 0) - (Number(bv) || 0)) * dir;
      }
      return String(av || "")
        .toLowerCase()
        .localeCompare(String(bv || "").toLowerCase()) * dir;
    });
  }

  function filteredMembers() {
    var q = SEARCH_TERM.trim().toLowerCase();
    var list = MEMBERS_CACHE;
    if (ROLE_FILTER) {
      list = list.filter(function (m) {
        return m.role === ROLE_FILTER;
      });
    }
    if (q) {
      list = list.filter(function (m) {
        return (
          String(m.username || "").toLowerCase().indexOf(q) !== -1 ||
          String(m.ign || "").toLowerCase().indexOf(q) !== -1 ||
          String(m.realName || "").toLowerCase().indexOf(q) !== -1
        );
      });
    }
    return sortMembers(list);
  }

  function renderMembersPage() {
    var tbody = el("admin-members-tbody");
    var info = el("admin-pager-info");
    var prev = el("admin-pager-prev");
    var next = el("admin-pager-next");
    if (!tbody) return;

    var list = filteredMembers();
    var total = list.length;
    var pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (PAGE_INDEX >= pageCount) PAGE_INDEX = pageCount - 1;
    if (PAGE_INDEX < 0) PAGE_INDEX = 0;

    var start = PAGE_INDEX * PAGE_SIZE;
    var slice = list.slice(start, start + PAGE_SIZE);

    tbody.innerHTML = "";
    if (!total) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="dash-table-empty">' +
        (SEARCH_TERM ? "No members match that search." : "No members yet.") +
        "</td></tr>";
    } else {
      slice.forEach(function (m) {
        tbody.appendChild(buildMemberRow(m));
      });
    }

    if (info) {
      if (!total) {
        info.textContent = "0 members";
      } else {
        info.textContent =
          "Page " +
          (PAGE_INDEX + 1) +
          " of " +
          pageCount +
          " · " +
          total +
          (total === 1 ? " member" : " members") +
          (SEARCH_TERM ? " (filtered)" : "");
      }
    }
    if (prev) prev.disabled = PAGE_INDEX <= 0;
    if (next) next.disabled = PAGE_INDEX >= pageCount - 1;
  }

  function buildMemberRow(m) {
    var tr = document.createElement("tr");
    var tdUser = document.createElement("td");
    tdUser.textContent = m.username;
    var tdIgn = document.createElement("td");
    tdIgn.textContent = m.ign || "";

    var tdClubRole = document.createElement("td");
    var currentClubRole = readClubRole(m);
    var clubSel = document.createElement("select");
    clubSel.className = "admin-clubrole-select";
    // If the DB still holds a legacy free-form value (e.g. "Squad Captain")
    // surface it at the top of the dropdown so an admin doesn't silently
    // clobber it just by touching the row.
    if (ALL_CLUB_ROLES.indexOf(currentClubRole) === -1) {
      var legacy = document.createElement("option");
      legacy.value = currentClubRole;
      legacy.textContent = currentClubRole + " (legacy)";
      legacy.selected = true;
      clubSel.appendChild(legacy);
    }
    ALL_CLUB_ROLES.forEach(function (cr) {
      var o = document.createElement("option");
      o.value = cr;
      o.textContent = cr;
      if (currentClubRole === cr) o.selected = true;
      clubSel.appendChild(o);
    });
    clubSel.addEventListener("change", function () {
      var next = clubSel.value;
      var prev = currentClubRole;
      clubSel.disabled = true;
      window.GarudaApi
        .adminUpdateMember(m.username, { clubRole: next })
        .then(function () {
          m.clubRole = next;
          currentClubRole = next;
          clubSel.disabled = false;
        })
        .catch(function (err) {
          alert((err && err.message) || "Could not change club role.");
          clubSel.value = prev;
          clubSel.disabled = false;
        });
    });
    tdClubRole.appendChild(clubSel);

    var tdPts = document.createElement("td");
    tdPts.textContent = String(m.points || 0);
    tdPts.className = "admin-num";
    var tdRole = document.createElement("td");
    var sel = document.createElement("select");
    ["user", "verifier", "admin"].forEach(function (r) {
      var o = document.createElement("option");
      o.value = r;
      o.textContent = r;
      if (m.role === r) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", function () {
      var nextRole = sel.value;
      sel.disabled = true;
      window.GarudaApi
        .adminUpdateMember(m.username, { role: nextRole })
        .then(function () {
          m.role = nextRole;
          sel.disabled = false;
          renderOverview();
        })
        .catch(function (err) {
          alert((err && err.message) || "Could not change role.");
          sel.value = m.role;
          sel.disabled = false;
        });
    });
    tdRole.appendChild(sel);

    var tdAct = document.createElement("td");
    tdAct.className = "admin-row-actions";
    var viewBtn = document.createElement("button");
    viewBtn.type = "button";
    viewBtn.className = "btn btn--primary btn--sm";
    viewBtn.textContent = "View";
    viewBtn.addEventListener("click", function () {
      openProfileModal(m.username);
    });
    var removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn btn--ghost btn--sm";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", function () {
      if (!confirm("Remove " + m.username + "?")) return;
      removeBtn.disabled = true;
      window.GarudaApi
        .adminDeleteMember(m.username)
        .then(function () {
          MEMBERS_CACHE = MEMBERS_CACHE.filter(function (x) {
            return x.username !== m.username;
          });
          renderMembersPage();
          renderOverview();
        })
        .catch(function (err) {
          alert((err && err.message) || "Could not delete.");
          removeBtn.disabled = false;
        });
    });
    tdAct.appendChild(viewBtn);
    tdAct.appendChild(removeBtn);

    tr.appendChild(tdUser);
    tr.appendChild(tdIgn);
    tr.appendChild(tdClubRole);
    tr.appendChild(tdPts);
    tr.appendChild(tdRole);
    tr.appendChild(tdAct);
    return tr;
  }

  function bindPager() {
    var prev = el("admin-pager-prev");
    var next = el("admin-pager-next");
    var sizeSel = el("admin-page-size");
    var search = el("admin-members-search");
    if (prev) {
      prev.addEventListener("click", function () {
        PAGE_INDEX = Math.max(0, PAGE_INDEX - 1);
        renderMembersPage();
      });
    }
    if (next) {
      next.addEventListener("click", function () {
        PAGE_INDEX = PAGE_INDEX + 1;
        renderMembersPage();
      });
    }
    if (sizeSel) {
      sizeSel.value = String(PAGE_SIZE);
      sizeSel.addEventListener("change", function () {
        var n = parseInt(sizeSel.value, 10) || 25;
        PAGE_SIZE = n;
        PAGE_INDEX = 0;
        renderMembersPage();
      });
    }
    if (search) {
      var t = null;
      search.addEventListener("input", function () {
        clearTimeout(t);
        t = setTimeout(function () {
          SEARCH_TERM = search.value || "";
          PAGE_INDEX = 0;
          renderMembersPage();
        }, 120);
      });
    }
  }

  function fmtDateTime(ts) {
    if (!ts) return "—";
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function statusPill(status) {
    var cls =
      status === "verified"
        ? "pill pill--ok"
        : status === "rejected"
          ? "pill pill--bad"
          : "pill";
    return '<span class="' + cls + '">' + esc(status || "—") + "</span>";
  }

  function bindProfileModal() {
    var modal = el("admin-profile-modal");
    if (!modal) return;
    modal.addEventListener("click", function (e) {
      var t = e.target;
      if (t && t.getAttribute && t.getAttribute("data-close-modal") !== null) {
        closeProfileModal();
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !modal.hidden) closeProfileModal();
    });
  }

  function closeProfileModal() {
    var modal = el("admin-profile-modal");
    if (modal) modal.hidden = true;
    document.body.classList.remove("admin-modal-open");
  }

  function openProfileModal(username) {
    var modal = el("admin-profile-modal");
    var body = el("admin-profile-body");
    var title = el("admin-profile-title");
    if (!modal || !body) return;
    modal.hidden = false;
    document.body.classList.add("admin-modal-open");
    if (title) title.textContent = "Member profile — " + username;
    body.innerHTML = '<p class="admin-status">Loading…</p>';
    window.GarudaApi
      .adminGetMember(username)
      .then(function (data) {
        renderProfileView(data);
      })
      .catch(function (err) {
        body.innerHTML =
          '<p class="admin-status">' +
          esc((err && err.message) || "Could not load profile.") +
          "</p>";
      });
  }

  function renderProfileView(data) {
    var body = el("admin-profile-body");
    if (!body) return;
    var p = (data && data.profile) || {};
    var totpEnabled = !!p.totpEnabled;
    body.innerHTML =
      '<div class="admin-profile-actions">' +
      '<button type="button" class="btn btn--primary btn--sm" id="admin-profile-edit">Edit profile</button>' +
      '<button type="button" class="btn btn--secondary btn--sm" id="admin-issue-reset">Issue password reset link</button>' +
      '<button type="button" class="btn btn--secondary btn--sm" id="admin-view-security">Security history</button>' +
      (totpEnabled
        ? '<button type="button" class="btn btn--ghost btn--sm" id="admin-disable-2fa">Disable 2FA</button>'
        : '<span class="admin-inline-note">2FA not enabled</span>') +
      "</div>" +
      '<div id="admin-security-result" class="admin-status" hidden></div>' +
      '<div id="admin-security-panel" class="admin-security-panel" hidden></div>' +
      buildProfileHtml(data);
    var editBtn = el("admin-profile-edit");
    if (editBtn) {
      editBtn.addEventListener("click", function () {
        renderProfileEdit(data);
      });
    }
    var resetBtn = el("admin-issue-reset");
    if (resetBtn) resetBtn.addEventListener("click", function () {
      adminIssueResetLink(p.username);
    });
    var disable2faBtn = el("admin-disable-2fa");
    if (disable2faBtn) disable2faBtn.addEventListener("click", function () {
      adminDisableMemberTwoFactor(p.username);
    });
    var secBtn = el("admin-view-security");
    if (secBtn) secBtn.addEventListener("click", function () {
      adminViewSecurity(p.username);
    });
  }

  // v1.13.0: fetch /api/admin/members/:u/security and render a
  // timeline of sessions + security audit events + security inbox.
  // Renders into #admin-security-panel; toggles open/closed on
  // repeated clicks.
  function adminViewSecurity(username) {
    var panel = el("admin-security-panel");
    if (!panel) return;
    if (!panel.hidden && panel.dataset.username === username) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    panel.dataset.username = username;
    panel.innerHTML = '<p class="admin-status">Loading security history…</p>';
    window.GarudaApi
      .adminGetMemberSecurity(username)
      .then(function (data) {
        renderSecurityPanel(panel, data);
      })
      .catch(function (err) {
        panel.innerHTML =
          '<p class="admin-status">' +
          esc((err && err.message) || "Could not load security history.") +
          "</p>";
      });
  }

  function fmtWhen(ts) {
    if (!ts) return "";
    try {
      return new Date(ts).toLocaleString();
    } catch (_) {
      return String(ts);
    }
  }

  function renderSecurityPanel(panel, data) {
    var p = data.profile || {};
    var sessions = Array.isArray(data.sessions) ? data.sessions : [];
    var audit = Array.isArray(data.audit) ? data.audit : [];
    var notifs = Array.isArray(data.notifications) ? data.notifications : [];

    var profileBits = [];
    profileBits.push(
      "<strong>2FA:</strong> " +
        (p.totpEnabled ? "ON" : "off") +
        (p.totpEnabled
          ? " (" +
            p.recoveryCodesRemaining +
            "/" +
            p.recoveryCodesTotal +
            " recovery codes left)"
          : "")
    );
    profileBits.push(
      "<strong>Email:</strong> " +
        (p.email ? esc(p.email) : "—") +
        (p.email
          ? " (" + (p.emailVerified ? "verified" : "unverified") + ")"
          : "")
    );
    profileBits.push(
      "<strong>Account created:</strong> " + esc(fmtWhen(p.createdAt))
    );

    var sessionHtml = sessions.length
      ? '<ul class="admin-sec-list">' +
        sessions
          .map(function (s) {
            return (
              "<li>" +
              "<span class=\"admin-sec-head\">" +
              esc(s.browser || "Browser") +
              (s.platform ? " · " + esc(s.platform) : "") +
              "</span>" +
              '<span class="admin-sec-meta">' +
              (s.location ? esc(s.location) + " · " : "") +
              (s.ip ? esc(s.ip) + " · " : "") +
              "last seen " +
              esc(fmtWhen(s.lastSeenAt || s.createdAt)) +
              " · expires " +
              esc(fmtWhen(s.expiresAt)) +
              "</span>" +
              "</li>"
            );
          })
          .join("") +
        "</ul>"
      : "<p class=\"admin-status\">No active sessions.</p>";

    var auditHtml = audit.length
      ? '<ul class="admin-sec-list">' +
        audit
          .map(function (a) {
            var detail = a.detail && typeof a.detail === "object" ? a.detail : {};
            var detailKeys = Object.keys(detail);
            var detailStr = detailKeys.length
              ? detailKeys
                  .map(function (k) {
                    return k + "=" + JSON.stringify(detail[k]);
                  })
                  .join(", ")
              : "";
            return (
              "<li>" +
              '<span class="admin-sec-head">' +
              esc(a.action) +
              (a.actor && a.actor !== p.username
                ? " by " + esc(a.actor)
                : "") +
              "</span>" +
              '<span class="admin-sec-meta">' +
              esc(fmtWhen(a.createdAt)) +
              (a.ip ? " · " + esc(a.ip) : "") +
              (detailStr ? " · " + esc(detailStr) : "") +
              "</span>" +
              "</li>"
            );
          })
          .join("") +
        "</ul>"
      : "<p class=\"admin-status\">No security events logged.</p>";

    var notifsHtml = notifs.length
      ? '<ul class="admin-sec-list">' +
        notifs
          .map(function (n) {
            return (
              "<li>" +
              '<span class="admin-sec-head">' +
              esc(n.title) +
              "</span>" +
              '<span class="admin-sec-meta">' +
              esc(fmtWhen(n.createdAt)) +
              (n.readAt ? " · read" : " · unread") +
              "</span>" +
              (n.body
                ? '<div class="admin-sec-body">' + esc(n.body) + "</div>"
                : "") +
              "</li>"
            );
          })
          .join("") +
        "</ul>"
      : "<p class=\"admin-status\">No security notifications sent.</p>";

    panel.innerHTML =
      '<h3 class="admin-sec-title">Security history — ' +
      esc(p.username) +
      "</h3>" +
      '<div class="admin-sec-profile">' +
      profileBits.join(" · ") +
      "</div>" +
      '<h4 class="admin-sec-subtitle">Active sessions (' +
      sessions.length +
      ")</h4>" +
      sessionHtml +
      '<h4 class="admin-sec-subtitle">Security events (latest ' +
      audit.length +
      ")</h4>" +
      auditHtml +
      '<h4 class="admin-sec-subtitle">In-app security notifications</h4>' +
      notifsHtml;
  }

  function adminIssueResetLink(username) {
    var out = el("admin-security-result");
    if (!out) return;
    if (!window.confirm(
      "Issue a new password reset token for " + username + "?\n\n" +
      "Any previously issued reset links will be invalidated."
    )) return;
    out.hidden = false;
    out.textContent = "Generating reset link…";
    window.GarudaApi
      .adminIssueResetToken(username)
      .then(function (res) {
        var url =
          window.location.origin +
          "/forgot-password.html?token=" +
          encodeURIComponent(res.token);
        var expiry = res.expiresAt
          ? new Date(res.expiresAt).toLocaleString()
          : "24 hours";
        out.innerHTML =
          '<strong>Reset link (share privately — valid until ' +
          esc(expiry) +
          '):</strong><br />' +
          '<input type="text" readonly class="admin-copy" value="' +
          esc(url) +
          '" onclick="this.select()" />';
      })
      .catch(function (err) {
        out.textContent = (err && err.message) || "Could not issue token.";
      });
  }

  function adminDisableMemberTwoFactor(username) {
    var out = el("admin-security-result");
    if (!out) return;
    if (!window.confirm(
      "Disable two-factor authentication for " + username + "?\n\n" +
      "They will be able to sign in with just their password until they re-enroll."
    )) return;
    out.hidden = false;
    out.textContent = "Disabling 2FA…";
    window.GarudaApi
      .adminDisableTwoFactor(username)
      .then(function () {
        out.textContent = "Two-factor authentication disabled for " + username + ".";
        openProfileModal(username);
      })
      .catch(function (err) {
        out.textContent = (err && err.message) || "Could not disable 2FA.";
      });
  }

  var ALL_GAMES = [
    "Beyblade X",
    "Call of Duty: Mobile",
    "Dota 2",
    "Honor of Kings",
    "Mobile Legends",
    "Tekken",
    "Valorant"
  ];
  var ALL_SQUADS = [
    "Garuda Dark Phoenix",
    "Garuda Esports",
    "Garuda Guardian",
    "Garuda Harpy",
    "Garuda Macaw",
    "Garuda Tengu",
    "Garuda Vortex"
  ];
  // Club role — a strict enum maintained in step with the server-side
  // ALLOWED_CLUB_ROLES in server/index.js. Note: "club role" is the
  // squad-level title (Captain / Vice Captain / Member), deliberately
  // separate from the system role (user / verifier / admin) that controls
  // access.
  var ALL_CLUB_ROLES = [
    "Founder",
    "Head Captain",
    "Captain",
    "Vice Captain",
    "Member",
  ];
  function readClubRole(m) {
    if (!m) return "Member";
    return m.clubRole || "Member";
  }

  function renderProfileEdit(data) {
    var body = el("admin-profile-body");
    if (!body) return;
    var p = (data && data.profile) || {};
    var games = Array.isArray(p.games) ? p.games : [];
    var squadOptionsHtml = ALL_SQUADS.map(function (s) {
      return (
        '<option value="' +
        esc(s) +
        '"' +
        (p.squad === s ? " selected" : "") +
        ">" +
        esc(s) +
        "</option>"
      );
    }).join("");
    if (p.squad && ALL_SQUADS.indexOf(p.squad) === -1) {
      squadOptionsHtml =
        '<option value="' +
        esc(p.squad) +
        '" selected>' +
        esc(p.squad) +
        " (custom)</option>" +
        squadOptionsHtml;
    }
    var gameOptionsHtml = ALL_GAMES.map(function (g) {
      return (
        '<option value="' +
        esc(g) +
        '"' +
        (games.indexOf(g) !== -1 ? " selected" : "") +
        ">" +
        esc(g) +
        "</option>"
      );
    }).join("");

    body.innerHTML =
      '<form id="admin-edit-form" class="admin-edit-form">' +
      '<h3 class="admin-subtitle">Edit ' +
      esc(p.username) +
      "</h3>" +
      '<div class="admin-edit-grid">' +
      '<label>System role<select id="edit-role">' +
      ["user", "verifier", "admin"]
        .map(function (r) {
          return (
            '<option value="' +
            r +
            '"' +
            (p.role === r ? " selected" : "") +
            ">" +
            r +
            "</option>"
          );
        })
        .join("") +
      "</select></label>" +
      '<label>IGN<input type="text" id="edit-ign" maxlength="64" value="' +
      esc(p.ign || "") +
      '" /></label>' +
      '<label>Full name<input type="text" id="edit-realname" maxlength="128" value="' +
      esc(p.realName || "") +
      '" /></label>' +
      '<label>Squad<select id="edit-squad">' +
      squadOptionsHtml +
      "</select></label>" +
      '<label>Club role<select id="edit-clubrole">' +
      (function () {
        var cur = p.clubRole || "Member";
        var opts = "";
        if (ALL_CLUB_ROLES.indexOf(cur) === -1) {
          opts +=
            '<option value="' +
            esc(cur) +
            '" selected>' +
            esc(cur) +
            " (legacy)</option>";
        }
        ALL_CLUB_ROLES.forEach(function (cr) {
          opts +=
            '<option value="' +
            esc(cr) +
            '"' +
            (cur === cr ? " selected" : "") +
            ">" +
            esc(cr) +
            "</option>";
        });
        return opts;
      })() +
      "</select></label>" +
      '<label>Games (Ctrl/Cmd-click to multi-select)<select id="edit-games" multiple size="6">' +
      gameOptionsHtml +
      "</select></label>" +
      '<label class="admin-check"><input type="checkbox" id="edit-judge"' +
      (p.certifiedJudge ? " checked" : "") +
      " /> Certified Judge</label>" +
      (function () {
        var catalog =
          (window.ProFlags && window.ProFlags.catalog) ||
          [{ name: "Beyblade X", short: "Beyblade X" }];
        var active =
          (window.ProFlags && window.ProFlags.normalize(p.proGames)) ||
          (p.professionalBlader ? ["Beyblade X"] : []);
        var set = Object.create(null);
        active.forEach(function (g) { set[g] = true; });
        var items = catalog
          .map(function (g) {
            var id = "edit-pro-" + g.name.toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "");
            return (
              '<label class="admin-check admin-pro-games__item" for="' +
              id + '">' +
              '<input type="checkbox" class="admin-pro-game" id="' +
              id + '" data-pro-game="' + esc(g.name) + '"' +
              (set[g.name] ? " checked" : "") +
              " /> PRO " + esc(g.short || g.name) + "</label>"
            );
          })
          .join("");
        return (
          '<fieldset class="admin-pro-games">' +
          '<legend>Professional Games</legend>' +
          '<div class="admin-pro-games__list">' + items + '</div>' +
          '</fieldset>'
        );
      })() +
      '<label>Points<input type="number" id="edit-points" min="0" value="' +
      (Number(p.points) || 0) +
      '" /></label>' +
      '<label>Reset password (blank = keep)<input type="password" id="edit-password" autocomplete="new-password" placeholder="12+ chars to reset" /></label>' +
      "</div>" +
      '<div class="admin-profile-actions">' +
      '<button type="submit" class="btn btn--primary">Save changes</button>' +
      '<button type="button" class="btn btn--ghost" id="admin-edit-cancel">Cancel</button>' +
      "</div>" +
      '<p id="admin-edit-status" class="dash-upload-status" aria-live="polite"></p>' +
      "</form>";

    var form = el("admin-edit-form");
    var cancel = el("admin-edit-cancel");
    if (cancel) {
      cancel.addEventListener("click", function () {
        renderProfileView(data);
      });
    }
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var status = el("admin-edit-status");
        var payload = {
          role: el("edit-role").value,
          ign: el("edit-ign").value.trim(),
          realName: el("edit-realname").value.trim(),
          squad: el("edit-squad").value,
          clubRole: el("edit-clubrole").value || "Member",
          games: Array.prototype.slice
            .call(el("edit-games").selectedOptions)
            .map(function (o) {
              return o.value;
            }),
          certifiedJudge: !!el("edit-judge").checked,
          proGames: Array.prototype.slice
            .call(form.querySelectorAll("input.admin-pro-game:checked"))
            .map(function (cb) { return cb.dataset.proGame; }),
          points: parseInt(el("edit-points").value, 10) || 0
        };
        var pw = el("edit-password").value;
        if (pw) payload.password = pw;
        status.textContent = "Saving…";
        window.GarudaApi
          .adminUpdateMember(p.username, payload)
          .then(function () {
            return window.GarudaApi.adminGetMember(p.username);
          })
          .then(function (fresh) {
            status.textContent = "Saved.";
            // Update cache so the row reflects changes without full reload.
            var cached = MEMBERS_CACHE.find(function (x) {
              return x.username === p.username;
            });
            if (cached && fresh && fresh.profile) {
              cached.role = fresh.profile.role;
              cached.ign = fresh.profile.ign;
              cached.realName = fresh.profile.realName;
              cached.squad = fresh.profile.squad;
              cached.clubRole = fresh.profile.clubRole;
              cached.points = fresh.profile.points;
            }
            renderMembersPage();
            renderOverview();
            renderProfileView(fresh);
          })
          .catch(function (err) {
            status.textContent = (err && err.message) || "Could not save.";
          });
      });
    }
  }

  function buildProfileHtml(data) {
    var p = (data && data.profile) || {};
    var s = (data && data.submissions) || {};
    var r = (data && data.recent) || {};
    var games = Array.isArray(p.games) ? p.games : [];
    var photo = p.photoDataUrl
      ? '<img class="admin-profile__photo" alt="" src="' + esc(p.photoDataUrl) + '"/>'
      : '<div class="admin-profile__photo admin-profile__photo--empty" aria-hidden="true">No photo</div>';

    var flags = [];
    if (p.certifiedJudge) flags.push("Certified Judge");
    var pFlagGames =
      (window.ProFlags && window.ProFlags.normalize(p.proGames)) ||
      (p.professionalBlader ? ["Beyblade X"] : []);
    pFlagGames.forEach(function (g) {
      flags.push(window.ProFlags ? window.ProFlags.label(g) : "PRO " + g);
    });

    var ach = s.achievements || { pending: 0, verified: 0, rejected: 0 };
    var jlap = s.jlap || { pending: 0, verified: 0, rejected: 0 };
    var flg = s.idFlags || { pending: 0, verified: 0, rejected: 0 };

    function recentAch() {
      var list = (r.achievements || []).slice(0, 5);
      if (!list.length) return '<p class="admin-status">No achievements yet.</p>';
      return (
        '<table class="dash-table"><thead><tr><th>Event</th><th>Rank</th><th>Pts</th><th>Status</th><th>Submitted</th></tr></thead><tbody>' +
        list
          .map(function (x) {
            return (
              "<tr><td>" +
              esc(x.eventName) +
              "</td><td>" +
              esc(x.rank) +
              '</td><td class="admin-num">' +
              (x.rankPoints || 0) +
              "</td><td>" +
              statusPill(x.status) +
              "</td><td>" +
              esc(fmtDateTime(x.createdAt)) +
              "</td></tr>"
            );
          })
          .join("") +
        "</tbody></table>"
      );
    }

    function recentJlap() {
      var list = (r.jlap || []).slice(0, 5);
      if (!list.length) return '<p class="admin-status">No JLAP submissions.</p>';
      return (
        '<table class="dash-table"><thead><tr><th>Status</th><th>Submitted</th></tr></thead><tbody>' +
        list
          .map(function (x) {
            return (
              "<tr><td>" +
              statusPill(x.status) +
              "</td><td>" +
              esc(fmtDateTime(x.createdAt)) +
              "</td></tr>"
            );
          })
          .join("") +
        "</tbody></table>"
      );
    }

    function recentFlags() {
      var list = (r.idFlags || []).slice(0, 5);
      if (!list.length) return '<p class="admin-status">No ID flag requests.</p>';
      return (
        '<table class="dash-table"><thead><tr><th>Requested</th><th>Status</th><th>Submitted</th><th>Note</th></tr></thead><tbody>' +
        list
          .map(function (x) {
            var parts = [];
            if (x.certifiedJudge) parts.push("Judge");
            if (x.professionalBlader) parts.push("Blader");
            var req = parts.length ? parts.join(", ") : "Clear";
            return (
              "<tr><td>" +
              esc(req) +
              "</td><td>" +
              statusPill(x.status) +
              "</td><td>" +
              esc(fmtDateTime(x.createdAt)) +
              "</td><td>" +
              esc(x.verifierNote || "—") +
              "</td></tr>"
            );
          })
          .join("") +
        "</tbody></table>"
      );
    }

    return (
      '<div class="admin-profile">' +
      '<div class="admin-profile__photo-wrap">' +
      photo +
      "</div>" +
      '<div class="admin-profile__meta">' +
      '<dl class="admin-profile__dl">' +
      '<dt>Username</dt><dd>' + esc(p.username || "") + '</dd>' +
      '<dt>System role</dt><dd>' + esc(p.role || "") + '</dd>' +
      '<dt>IGN</dt><dd>' + esc(p.ign || "—") + '</dd>' +
      '<dt>Full name</dt><dd>' + esc(p.realName || "—") + '</dd>' +
      '<dt>Squad</dt><dd>' + esc(p.squad || "—") + '</dd>' +
      '<dt>Club role</dt><dd>' + esc(p.clubRole || "—") + '</dd>' +
      '<dt>Games</dt><dd>' + (games.length ? games.map(esc).join(", ") : "—") + '</dd>' +
      '<dt>Points</dt><dd class="admin-num">' + (p.points || 0) + '</dd>' +
      '<dt>ID flags</dt><dd>' + (flags.length ? flags.map(esc).join(", ") : "—") + '</dd>' +
      '<dt>Joined</dt><dd>' + esc(fmtDateTime(p.createdAt)) + '</dd>' +
      "</dl>" +
      "</div>" +
      "</div>" +
      '<h3 class="admin-subtitle">Submissions summary</h3>' +
      '<div class="stats-grid stats-grid--compact">' +
      '<article class="stats-card"><span class="stats-card__label">Achievements</span><strong class="stats-card__value">' +
      (ach.pending + ach.verified + ach.rejected) +
      '</strong><span class="stats-card__sub">' +
      ach.pending + " pending · " + ach.verified + " verified · " + ach.rejected + " rejected" +
      "</span></article>" +
      '<article class="stats-card"><span class="stats-card__label">JLAP</span><strong class="stats-card__value">' +
      (jlap.pending + jlap.verified + jlap.rejected) +
      '</strong><span class="stats-card__sub">' +
      jlap.pending + " pending · " + jlap.verified + " verified · " + jlap.rejected + " rejected" +
      "</span></article>" +
      '<article class="stats-card"><span class="stats-card__label">ID flags</span><strong class="stats-card__value">' +
      (flg.pending + flg.verified + flg.rejected) +
      '</strong><span class="stats-card__sub">' +
      flg.pending + " pending · " + flg.verified + " verified · " + flg.rejected + " rejected" +
      "</span></article>" +
      "</div>" +
      '<h3 class="admin-subtitle">Recent achievements</h3>' +
      recentAch() +
      '<h3 class="admin-subtitle">Recent JLAP</h3>' +
      recentJlap() +
      '<h3 class="admin-subtitle">Recent ID flag requests</h3>' +
      recentFlags()
    );
  }

  function bindAddMember() {
    var btn = el("admin-add-member");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var u = el("adm-username").value.trim().toLowerCase();
      var p = el("adm-password").value;
      var role = el("adm-role").value;
      var ign = el("adm-ign").value.trim();
      var rn = el("adm-realname").value.trim();
      var squad = el("adm-squad").value.trim();
      var clubEl = el("adm-clubrole");
      var clubRole = (clubEl && clubEl.value) || "Member";
      var games = el("adm-games")
        .value.split(/[,\n]/)
        .map(function (g) {
          return g.trim();
        })
        .filter(Boolean);
      var st = el("adm-member-status");
      if (!u || !p || !ign) {
        st.textContent = "Username, password, and IGN required.";
        return;
      }
      st.textContent = "Creating…";
      btn.disabled = true;
      window.GarudaApi
        .adminCreateMember({
          username: u,
          password: p,
          role: role,
          ign: ign,
          realName: rn,
          squad: squad,
          clubRole: clubRole,
          games: games
        })
        .then(function () {
          st.textContent = "Saved. Member can sign in immediately.";
          el("adm-username").value = "";
          el("adm-password").value = "";
          renderMembers();
        })
        .catch(function (err) {
          st.textContent = (err && err.message) || "Could not create member.";
        })
        .finally(function () {
          btn.disabled = false;
        });
    });
  }

  function loadSiteForm() {
    window.GarudaApi
      .getSite()
      .then(function (res) {
        var c = (res && res.site) || {};
        if (el("adm-club-tag"))
          el("adm-club-tag").value =
            typeof c.clubTag === "string" ? c.clubTag : "GRD|TAS";
        if (el("adm-footer-note"))
          el("adm-footer-note").value = c.footerNote || "";
        if (el("adm-tagline"))
          el("adm-tagline").value = c.headerTagline || "";
        if (el("adm-head-captain"))
          el("adm-head-captain").value = c.headCaptain || "";
        if (el("adm-menu-json"))
          el("adm-menu-json").value = JSON.stringify(c.extraNav || [], null, 2);
        if (el("adm-org-html")) el("adm-org-html").value = c.orgChartHtml || "";
        if (el("adm-games-extra"))
          el("adm-games-extra").value = (c.gamesExtra || []).join("\n");
      })
      .catch(function () {});
  }

  function bindSaveSite() {
    var btn = el("admin-save-site");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var extraNav = [];
      try {
        extraNav = JSON.parse((el("adm-menu-json") && el("adm-menu-json").value) || "[]");
        if (!Array.isArray(extraNav)) throw new Error();
      } catch (e) {
        el("adm-site-status").textContent = "Menu JSON must be a JSON array.";
        return;
      }
      var gamesExtra = (el("adm-games-extra") ? el("adm-games-extra").value : "")
        .split("\n")
        .map(function (l) {
          return l.trim();
        })
        .filter(Boolean);
      var next = {
        clubTag: el("adm-club-tag") ? el("adm-club-tag").value.trim() : "",
        footerNote: el("adm-footer-note") ? el("adm-footer-note").value.trim() : "",
        headerTagline: el("adm-tagline") ? el("adm-tagline").value.trim() : "",
        headCaptain: el("adm-head-captain")
          ? el("adm-head-captain").value.trim()
          : "",
        extraNav: extraNav,
        orgChartHtml: el("adm-org-html") ? el("adm-org-html").value : "",
        gamesExtra: gamesExtra
      };
      var brandNew = el("adm-brand-data") ? el("adm-brand-data").value : "";
      if (brandNew) next.brandMarkDataUrl = brandNew;
      btn.disabled = true;
      el("adm-site-status").textContent = "Saving…";
      window.GarudaApi
        .saveSite(next)
        .then(function () {
          el("adm-site-status").textContent =
            "Saved. Public pages will read the new values on next load.";
        })
        .catch(function (err) {
          el("adm-site-status").textContent =
            (err && err.message) || "Could not save.";
        })
        .finally(function () {
          btn.disabled = false;
        });
    });
  }

  function bindBrandUpload() {
    var input = el("adm-brand-file");
    if (!input) return;
    input.addEventListener("change", function () {
      var f = input.files && input.files[0];
      if (!f) return;
      window.GarudaImageUtils
        .compressImageFile(f, { maxSide: 512, quality: 0.85 })
        .then(function (url) {
          if (el("adm-brand-data")) el("adm-brand-data").value = url;
          if (el("adm-site-status"))
            el("adm-site-status").textContent =
              "Logo ready — click Save site settings.";
        })
        .catch(function () {
          if (el("adm-site-status"))
            el("adm-site-status").textContent = "Logo processing failed.";
        });
    });
  }

  function doExport(btn) {
    if (!btn) return;
    btn.disabled = true;
    fetch("/api/admin/backup", { credentials: "same-origin" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.blob();
      })
      .then(function (blob) {
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "garuda-backup.json";
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch(function (err) {
        alert((err && err.message) || "Backup failed.");
      })
      .finally(function () {
        btn.disabled = false;
      });
  }

  function bindExport() {
    var btn = el("admin-export");
    if (btn) {
      btn.addEventListener("click", function () {
        doExport(btn);
      });
    }
    var btnTop = el("admin-export-top");
    if (btnTop) {
      btnTop.addEventListener("click", function () {
        doExport(btnTop);
      });
    }
  }

  function bindLogout() {
    var out = el("nav-logout");
    if (out) {
      out.addEventListener("click", function () {
        window.GarudaAuth.logout();
      });
    }
  }

  function bindRoleChips() {
    var wrap = el("admin-role-chips");
    if (!wrap) return;
    wrap.addEventListener("click", function (e) {
      var t = e.target;
      if (!t || t.tagName !== "BUTTON") return;
      var btns = wrap.querySelectorAll("button");
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.remove("chip--active");
        btns[i].setAttribute("aria-selected", "false");
      }
      t.classList.add("chip--active");
      t.setAttribute("aria-selected", "true");
      ROLE_FILTER = t.dataset.role || "";
      PAGE_INDEX = 0;
      renderMembersPage();
    });
  }

  function bindCsvExport() {
    var btn = el("admin-members-csv");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var rows = filteredMembers();
      if (!rows.length) {
        alert("Nothing to export with the current filter.");
        return;
      }
      var headers = [
        "username",
        "ign",
        "realName",
        "role",
        "squad",
        "clubRole",
        "points",
        "createdAt"
      ];
      function esc(v) {
        var s = v == null ? "" : String(v);
        if (/[,\"\n\r]/.test(s)) return '"' + s.replace(/\"/g, '""') + '"';
        return s;
      }
      var lines = [headers.join(",")];
      rows.forEach(function (r) {
        lines.push(
          headers
            .map(function (h) {
              if (h === "createdAt") return esc(fmtDateTime(r[h]));
              if (h === "clubRole") return esc(r.clubRole || "");
              return esc(r[h]);
            })
            .join(",")
        );
      });
      var blob = new Blob([lines.join("\n")], {
        type: "text/csv;charset=utf-8;"
      });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "garuda-members.csv";
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  function bindColumnSort() {
    var table = document.querySelector(".admin-members-table");
    if (!table) return;
    var ths = table.querySelectorAll("th[data-sort]");
    function refreshIndicators() {
      for (var i = 0; i < ths.length; i++) {
        var k = ths[i].getAttribute("data-sort");
        var ind = ths[i].querySelector(".admin-sort-indicator");
        if (!ind) continue;
        if (k === SORT_KEY) {
          ind.textContent = SORT_DIR > 0 ? "▲" : "▼";
          ths[i].classList.add("th-sorted");
        } else {
          ind.textContent = "";
          ths[i].classList.remove("th-sorted");
        }
      }
    }
    refreshIndicators();
    for (var i = 0; i < ths.length; i++) {
      (function (th) {
        th.addEventListener("click", function () {
          var k = th.getAttribute("data-sort");
          if (SORT_KEY === k) {
            SORT_DIR = -SORT_DIR;
          } else {
            SORT_KEY = k;
            SORT_DIR = 1;
          }
          PAGE_INDEX = 0;
          refreshIndicators();
          renderMembersPage();
        });
      })(ths[i]);
    }
  }

  // ------------------------------------------------------------------------
  // Audit log viewer
  // ------------------------------------------------------------------------

  var AUDIT_STATE = {
    action: "",
    actor: "",
    target: "",
    sinceDays: 0,
    nextBefore: null,
    total: 0,
    loaded: 0,
    actionsSet: {},
  };

  function auditFmtWhen(ts) {
    if (!ts) return "—";
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function auditSummarizeDetail(detail) {
    if (!detail || typeof detail !== "object") return "";
    var keys = Object.keys(detail);
    if (!keys.length) return "";
    var parts = [];
    for (var i = 0; i < keys.length && parts.length < 4; i++) {
      var v = detail[keys[i]];
      if (v == null || v === "") continue;
      var s;
      if (typeof v === "object") {
        try {
          s = JSON.stringify(v);
        } catch (_) {
          s = String(v);
        }
      } else {
        s = String(v);
      }
      if (s.length > 40) s = s.slice(0, 40) + "…";
      parts.push(keys[i] + ": " + s);
    }
    if (keys.length > parts.length) parts.push("…");
    return parts.join(" · ");
  }

  function auditEsc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function auditRenderRow(entry) {
    var tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" +
      auditEsc(auditFmtWhen(entry.createdAt)) +
      "</td><td>" +
      auditEsc(entry.actor || "—") +
      "</td><td><code>" +
      auditEsc(entry.action || "") +
      "</code></td><td>" +
      auditEsc(entry.target || "—") +
      "</td><td>" +
      auditEsc(entry.ip || "—") +
      '</td><td class="audit-detail"></td>';
    var td = tr.querySelector(".audit-detail");
    var summary = auditSummarizeDetail(entry.detail);
    if (summary) {
      var wrap = document.createElement("details");
      var sum = document.createElement("summary");
      sum.textContent = summary;
      wrap.appendChild(sum);
      var pre = document.createElement("pre");
      try {
        pre.textContent = JSON.stringify(entry.detail, null, 2);
      } catch (_) {
        pre.textContent = String(entry.detail);
      }
      wrap.appendChild(pre);
      td.appendChild(wrap);
    } else {
      td.textContent = "—";
    }
    return tr;
  }

  function auditRefreshActions(actions) {
    var sel = el("audit-action");
    if (!sel) return;
    var current = AUDIT_STATE.action;
    if (!actions || !actions.length) return;
    var known = AUDIT_STATE.actionsSet;
    var added = false;
    actions.forEach(function (a) {
      if (!known[a]) {
        known[a] = true;
        added = true;
      }
    });
    if (!added && sel.options.length > 1) return;
    sel.innerHTML = '<option value="">All actions</option>';
    Object.keys(known)
      .sort()
      .forEach(function (a) {
        var opt = document.createElement("option");
        opt.value = a;
        opt.textContent = a;
        if (a === current) opt.selected = true;
        sel.appendChild(opt);
      });
  }

  function auditUpdateMeta() {
    var meta = el("audit-meta");
    if (!meta) return;
    meta.textContent =
      "Showing " +
      AUDIT_STATE.loaded +
      " of " +
      AUDIT_STATE.total +
      " total entries.";
  }

  function auditLoad(reset) {
    var tbody = el("audit-tbody");
    var more = el("audit-load-more");
    if (!tbody) return;
    if (reset) {
      AUDIT_STATE.nextBefore = null;
      AUDIT_STATE.loaded = 0;
      tbody.innerHTML =
        '<tr><td colspan="6" class="dash-table-empty">Loading…</td></tr>';
    }
    var opts = {
      limit: 100,
      action: AUDIT_STATE.action || undefined,
      actor: AUDIT_STATE.actor || undefined,
      target: AUDIT_STATE.target || undefined,
    };
    if (AUDIT_STATE.sinceDays > 0) {
      opts.since = Date.now() - AUDIT_STATE.sinceDays * 86400000;
    }
    if (!reset && AUDIT_STATE.nextBefore) {
      opts.before = AUDIT_STATE.nextBefore;
    }
    return window.GarudaApi.adminAudit(opts).then(
      function (res) {
        var entries = (res && res.entries) || [];
        if (reset) tbody.innerHTML = "";
        if (!entries.length && reset) {
          tbody.innerHTML =
            '<tr><td colspan="6" class="dash-table-empty">No matching entries.</td></tr>';
        } else {
          entries.forEach(function (e) {
            tbody.appendChild(auditRenderRow(e));
          });
        }
        AUDIT_STATE.loaded += entries.length;
        AUDIT_STATE.total = (res && res.total) || AUDIT_STATE.total;
        AUDIT_STATE.nextBefore = (res && res.nextBefore) || null;
        auditRefreshActions((res && res.actions) || []);
        auditUpdateMeta();
        if (more) more.hidden = !AUDIT_STATE.nextBefore;
      },
      function (err) {
        tbody.innerHTML =
          '<tr><td colspan="6" class="dash-table-empty">Could not load: ' +
          auditEsc((err && err.message) || "error") +
          "</td></tr>";
      }
    );
  }

  function bindAuditPanel() {
    var actionSel = el("audit-action");
    var actorIn = el("audit-actor");
    var targetIn = el("audit-target");
    var sinceSel = el("audit-since");
    var refreshBtn = el("audit-refresh");
    var moreBtn = el("audit-load-more");
    if (!actionSel && !actorIn && !targetIn && !sinceSel) return;

    var debounceTimer = null;
    function scheduleReload() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        auditLoad(true);
      }, 300);
    }

    if (actionSel) {
      actionSel.addEventListener("change", function () {
        AUDIT_STATE.action = actionSel.value || "";
        auditLoad(true);
      });
    }
    if (actorIn) {
      actorIn.addEventListener("input", function () {
        AUDIT_STATE.actor = actorIn.value.trim();
        scheduleReload();
      });
    }
    if (targetIn) {
      targetIn.addEventListener("input", function () {
        AUDIT_STATE.target = targetIn.value.trim();
        scheduleReload();
      });
    }
    if (sinceSel) {
      sinceSel.addEventListener("change", function () {
        AUDIT_STATE.sinceDays = parseInt(sinceSel.value, 10) || 0;
        auditLoad(true);
      });
    }
    if (refreshBtn) {
      refreshBtn.addEventListener("click", function () {
        auditLoad(true);
      });
    }
    if (moreBtn) {
      moreBtn.addEventListener("click", function () {
        auditLoad(false);
      });
    }
    auditLoad(true);
  }

  // --------------------------------------------------------------------
  // v1.20.0 — Staff 2FA rollout card
  // --------------------------------------------------------------------
  //
  // Pulls /api/admin/staff-2fa-status, paints the tiles + the staff table,
  // and wires up a one-click "Nudge" button per row. Nudges hit a 24h
  // server-side cooldown, so the button just disables itself for the
  // round trip and shows whatever the server returned.

  function fmtHumanAgo(ts) {
    if (!ts) return "—";
    var now = Date.now();
    var d = now - Number(ts);
    if (!isFinite(d) || d < 0) return "—";
    var sec = Math.floor(d / 1000);
    if (sec < 60) return "just now";
    var min = Math.floor(sec / 60);
    if (min < 60) return min + " min ago";
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + "h ago";
    var days = Math.floor(hr / 24);
    if (days < 30) return days + "d ago";
    return fmtDate(ts);
  }

  function toneForRollout(agg) {
    if (!agg.totalStaff) return "neutral";
    if (!agg.withoutTotp) return "ok";
    if (!agg.graceActive) return "bad";
    if (agg.daysLeft != null && agg.daysLeft <= 3) return "bad";
    if (agg.daysLeft != null && agg.daysLeft <= 7) return "warn";
    return "pending";
  }

  function renderStaff2fa() {
    var tbody = el("adm-2fa-tbody");
    if (!tbody) return;
    var statusPill = el("adm-2fa-status-pill");
    var total = el("adm-2fa-total");
    var enabled = el("adm-2fa-enabled");
    var enabledSub = el("adm-2fa-enabled-sub");
    var missing = el("adm-2fa-missing");
    var missingSub = el("adm-2fa-missing-sub");
    var grace = el("adm-2fa-grace");
    var graceSub = el("adm-2fa-grace-sub");
    var card = el("admin-2fa-rollout");

    tbody.innerHTML =
      '<tr><td colspan="8" class="dash-table-empty">Loading…</td></tr>';

    window.GarudaApi.adminStaff2faStatus()
      .then(function (res) {
        var staff = (res && res.staff) || [];
        var agg = (res && res.aggregates) || {
          totalStaff: 0,
          withTotp: 0,
          withoutTotp: 0,
          graceUntil: null,
          graceActive: false,
          daysLeft: null,
        };

        total.textContent = String(agg.totalStaff);
        enabled.textContent = String(agg.withTotp);
        missing.textContent = String(agg.withoutTotp);
        enabledSub.textContent = agg.totalStaff
          ? Math.round((agg.withTotp / agg.totalStaff) * 100) + "% of staff"
          : "";
        missingSub.textContent = agg.withoutTotp
          ? "Still need TOTP"
          : "Everyone's on 2FA";
        if (agg.graceUntil) {
          grace.textContent = fmtDate(agg.graceUntil);
          if (agg.graceActive) {
            graceSub.textContent =
              (agg.daysLeft != null ? agg.daysLeft + " days" : "") +
              " until hard-gate";
          } else {
            graceSub.textContent = "Grace expired — 403 enforced";
          }
        } else {
          grace.textContent = "—";
          graceSub.textContent = "No grace window — enforced now";
        }

        if (card) {
          card.classList.remove(
            "admin-2fa-rollout--ok",
            "admin-2fa-rollout--warn",
            "admin-2fa-rollout--bad",
            "admin-2fa-rollout--pending",
            "admin-2fa-rollout--neutral"
          );
          card.classList.add("admin-2fa-rollout--" + toneForRollout(agg));
        }
        if (statusPill) {
          if (!agg.totalStaff) {
            statusPill.textContent = "No staff yet";
          } else if (!agg.withoutTotp) {
            statusPill.textContent = "All staff on 2FA";
          } else if (!agg.graceActive) {
            statusPill.textContent = "Enforcement active";
          } else {
            statusPill.textContent =
              agg.withoutTotp +
              " pending · " +
              (agg.daysLeft != null ? agg.daysLeft + "d left" : "grace");
          }
        }

        if (!staff.length) {
          tbody.innerHTML =
            '<tr><td colspan="8" class="dash-table-empty">No staff accounts yet.</td></tr>';
          return;
        }

        var sorted = staff.slice().sort(function (a, b) {
          if (a.totpEnabled !== b.totpEnabled) {
            return a.totpEnabled ? 1 : -1;
          }
          return a.username.localeCompare(b.username);
        });

        tbody.innerHTML = "";
        for (var i = 0; i < sorted.length; i++) {
          var m = sorted[i];
          var tr = document.createElement("tr");
          tr.dataset.username = m.username;
          var emailCell = m.emailVerified
            ? '<span class="pill pill--ok">Verified</span>'
            : m.hasEmail
            ? '<span class="pill pill--warn">Unverified</span>'
            : '<span class="pill pill--bad">Missing</span>';
          var tfaCell = m.totpEnabled
            ? '<span class="pill pill--ok">On</span>'
            : '<span class="pill pill--bad">Off</span>';
          var canNudge = !m.totpEnabled;
          var nudgeBtn = canNudge
            ? '<button type="button" class="btn btn--ghost btn--sm adm-2fa-nudge" data-user="' +
              esc(m.username) +
              '">Nudge</button>'
            : '<span class="dash-table-empty" style="padding:0">—</span>';
          tr.innerHTML =
            "<td><strong>" +
            esc(m.username) +
            "</strong></td>" +
            "<td>" +
            esc(m.role) +
            "</td>" +
            "<td>" +
            tfaCell +
            "</td>" +
            "<td>" +
            emailCell +
            "</td>" +
            "<td>" +
            esc(fmtHumanAgo(m.lastSeenAt)) +
            "</td>" +
            "<td>" +
            esc(fmtHumanAgo(m.lastDeniedAt)) +
            "</td>" +
            "<td>" +
            esc(fmtHumanAgo(m.lastNudgeAt)) +
            "</td>" +
            "<td>" +
            nudgeBtn +
            "</td>";
          tbody.appendChild(tr);
        }
        bindNudgeButtons(tbody);
      })
      .catch(function (err) {
        tbody.innerHTML =
          '<tr><td colspan="8" class="dash-table-empty">' +
          esc((err && err.message) || "Couldn\u2019t load 2FA rollout status.") +
          "</td></tr>";
      });
  }

  function bindNudgeButtons(tbody) {
    var btns = tbody.querySelectorAll(".adm-2fa-nudge");
    for (var i = 0; i < btns.length; i++) {
      (function (btn) {
        btn.addEventListener("click", function () {
          var user = btn.dataset.user;
          if (!user) return;
          btn.disabled = true;
          var prev = btn.textContent;
          btn.textContent = "Sending…";
          window.GarudaApi
            .adminStaff2faNudge(user)
            .then(function (res) {
              btn.textContent = res && res.emailed
                ? "Sent (inbox + email)"
                : "Sent (inbox)";
              setTimeout(function () {
                renderStaff2fa();
              }, 800);
            })
            .catch(function (err) {
              btn.disabled = false;
              btn.textContent = prev;
              alert((err && err.message) || "Couldn\u2019t nudge that user.");
            });
        });
      })(btns[i]);
    }
  }
})();
