/* League and coach tools for Verdict Debate.
   - Coaches: start a league (get a code, a student link, and a private coach key), read the dashboard
     (students, weekly activity, fallacies, rounds), post practice assignments, download CSVs, and
     remove a student's rounds.
   - Students: open a join link (?league=CODE) and see their coach's current assignment in Setup.
   A league still works with only a shared code. Registering adds the coach key, which is stored as a
   hash on the server and cannot be shown again.
   Depends on app.html globals: t, escapeHtml, state, toast, friendlyError, navTo, Stats, DEBATE_MODES,
   openStudy, openFallacyLibrary, JUDGE_PERSONAS. */
(function () {
  "use strict";

  var STORE_KEY = "verdictai_coach";      // { CODE: { name, key } } on this device only
  var STUDENT_KEY = "verdictai_league";   // the student's league code, so they don't retype it
  var L = { code: "", coach: null, data: null, assignments: [] };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return escapeHtml(String(s == null ? "" : s)); }
  function tf(key, vars) {
    var s = t(key);
    if (vars) Object.keys(vars).forEach(function (k) { s = s.split("{" + k + "}").join(vars[k]); });
    return s;
  }
  function read(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function vid() { try { return localStorage.getItem("verdictai_vid") || ""; } catch (e) { return ""; } }
  function creds() { return read(STORE_KEY) || {}; }
  function norm(code) { return String(code || "").trim().toUpperCase(); }
  function joinLink(code) { return new URL("app.html?league=" + encodeURIComponent(code), location.href).href; }
  function dateLabel(iso) { try { return new Date(iso).toLocaleDateString(); } catch (e) { return ""; } }
  function copy(text, okMsg) {
    var done = function () { toast(okMsg || t("league.copied"), "success"); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { toast(t("league.copyfail"), "warn"); });
    else toast(t("league.copyfail"), "warn");
  }
  function download(name, text, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type || "text/plain" }));
    var a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function csv(rows) {
    return rows.map(function (r) {
      return r.map(function (c) {
        var s = String(c == null ? "" : c);
        if (/^[=+\-@]/.test(s)) s = "'" + s; // keep spreadsheets from running a student's name as a formula
        return '"' + s.replace(/"/g, '""') + '"';
      }).join(",");
    }).join("\r\n");
  }
  function api(path, body) {
    return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || "Request failed (" + r.status + ")"); return d; });
    });
  }

  /* ------------------------------------------------------------------ start a league */
  window.createLeague = function () {
    var input = $("league-new-name"), err = $("league-create-error"), box = $("league-created");
    err.style.display = "none";
    var name = input.value.trim();
    if (name.length < 3) { err.textContent = t("league.create.short"); err.style.display = ""; return; }
    var btn = $("league-create-btn"); btn.disabled = true;
    api("/api/league-create", { name: name, vid: vid() }).then(function (d) {
      var all = creds(); all[d.code] = { name: d.name, key: d.coachKey }; write(STORE_KEY, all);
      Stats.feature("league_create");
      box.innerHTML = createdHtml(d);
      box.querySelector("[data-copy-code]").addEventListener("click", function () { copy(d.code); });
      box.querySelector("[data-copy-link]").addEventListener("click", function () { copy(joinLink(d.code)); });
      box.querySelector("[data-copy-key]").addEventListener("click", function () { copy(d.coachKey); });
      box.querySelector("[data-dl-key]").addEventListener("click", function () {
        download("coach-key-" + d.code + ".txt", d.name + "\r\nLeague code: " + d.code + "\r\nCoach key: " + d.coachKey + "\r\nStudent link: " + joinLink(d.code) + "\r\n\r\nKeep this private. The coach key unlocks assignments and student removal. It can't be shown again.\r\n");
      });
      box.querySelector("[data-handout]").addEventListener("click", function () { printHandout(d.code, d.name); });
      box.querySelector("[data-open]").addEventListener("click", function () { $("league-lookup-code").value = d.code; loadLeagueDashboard(); });
      input.value = "";
    }).catch(function (e) { err.textContent = friendlyError(e); err.style.display = ""; }).then(function () { btn.disabled = false; });
  };

  function createdHtml(d) {
    return '<div class="league-created">' +
      "<h4>" + esc(tf("league.created", { name: d.name })) + "</h4>" +
      '<div class="lc-row"><span class="lc-label">' + esc(t("league.code")) + '</span><b class="lc-big">' + esc(d.code) + '</b><button type="button" class="btn btn-sm" data-copy-code>' + esc(t("league.copy")) + "</button></div>" +
      '<div class="lc-row"><span class="lc-label">' + esc(t("league.link")) + '</span><code class="lc-link">' + esc(joinLink(d.code)) + '</code><button type="button" class="btn btn-sm" data-copy-link>' + esc(t("league.copy")) + "</button></div>" +
      '<div class="lc-key"><b>' + esc(t("league.coachkey.title")) + ":</b> <code>" + esc(d.coachKey) + '</code> <button type="button" class="btn btn-sm" data-copy-key>' + esc(t("league.copy")) + '</button> <button type="button" class="btn btn-sm" data-dl-key>' + esc(t("league.coachkey.download")) + "</button>" +
      '<p class="lc-warn">' + esc(t("league.coachkey.warn")) + "</p></div>" +
      '<div class="lc-actions"><button type="button" class="btn btn-primary" data-open>' + esc(t("league.opendash")) + '</button><button type="button" class="btn" data-handout>' + esc(t("league.handout")) + "</button></div></div>";
  }

  function printHandout(code, name) {
    var link = joinLink(code);
    var html = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(name) + '</title><style>' +
      'body{font:16px/1.55 Georgia,serif;margin:40px;color:#111}h1{font-size:30px;margin:0 0 4px}.code{font:700 34px monospace;letter-spacing:3px;border:3px solid #111;display:inline-block;padding:6px 16px;margin:10px 0}' +
      'ol{padding-left:22px}li{margin-bottom:8px}.small{font-size:13px;color:#444;margin-top:28px;border-top:1px solid #999;padding-top:10px}</style></head><body>' +
      "<h1>" + esc(tf("handout.title", { name: name })) + "</h1><p>" + esc(t("handout.sub")) + "</p><div class=\"code\">" + esc(code) + "</div>" +
      "<ol><li>" + esc(tf("handout.step1", { link: link })) + "</li><li>" + esc(tf("handout.step2", { code: code })) + "</li><li>" + esc(t("handout.step3")) + "</li></ol>" +
      '<p class="small">' + esc(t("handout.privacy")) + "</p></body></html>";
    var url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    var w = window.open(url, "_blank", "width=820,height=900");
    if (!w) { toast(t("trial.popup"), "warn"); return; }
    w.addEventListener("load", function () { try { w.print(); } catch (e) {} });
    setTimeout(function () { URL.revokeObjectURL(url); }, 20000);
  }

  /* ------------------------------------------------------------------ the dashboard */
  window.loadLeagueDashboard = function (codeArg) {
    var code = norm(typeof codeArg === "string" ? codeArg : $("league-lookup-code").value);
    var errEl = $("league-error"), resEl = $("league-results");
    errEl.style.display = "none";
    if (!code) { errEl.textContent = t("league.nocode"); errEl.style.display = ""; return Promise.resolve(); }
    var typedKey = ($("league-coach-key").value || "").trim();
    var btn = $("league-go"); btn.disabled = true;
    resEl.innerHTML = '<div class="verdict-card"><div class="verdict-loading"><div class="spinner"></div>' + esc(t("league.loading")) + "</div></div>";
    Stats.feature("league_dashboard");
    var coachPromise = typedKey
      ? api("/api/league-coach-check", { code: code, coachKey: typedKey }).then(function (d) { var all = creds(); all[code] = { name: d.name, key: typedKey }; write(STORE_KEY, all); $("league-coach-key").value = ""; return all[code]; })
      : Promise.resolve(creds()[code] || null);
    return coachPromise.catch(function (e) { errEl.textContent = e.message || t("league.coach.invalid"); errEl.style.display = ""; return null; }).then(function (coach) {
      L.code = code; L.coach = coach;
      return fetch("/api/league-stats?code=" + encodeURIComponent(code)).then(function (r) {
        return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "Request failed (" + r.status + ")"); return d; });
      }).then(function (data) {
        L.data = data;
        return fetch("/api/league-assignments?code=" + encodeURIComponent(code)).then(function (r) { return r.json(); }).catch(function () { return {}; }).then(function (a) {
          L.assignments = a.assignments || [];
          renderDashboard();
        });
      });
    }).catch(function (e) { resEl.innerHTML = ""; errEl.textContent = t("league.loadfail") + " " + friendlyError(e); errEl.style.display = ""; }).then(function () { btn.disabled = false; });
  };

  function bars(weekly) {
    var max = Math.max.apply(null, [1].concat(weekly));
    return '<div class="week-bars" role="img" aria-label="' + esc(t("league.weekly")) + '">' + weekly.map(function (n, i) {
      return '<div class="wk"><i style="height:' + Math.round(n / max * 100) + '%" title="' + n + '"></i><span>' + (i === weekly.length - 1 ? esc(t("league.thisweek")) : "−" + (weekly.length - 1 - i)) + "</span><b>" + n + "</b></div>";
    }).join("") + "</div>";
  }

  function renderDashboard() {
    var d = L.data, resEl = $("league-results"), coach = !!L.coach;
    if (!d.totalRounds) {
      resEl.innerHTML = headerHtml(d, coach) + '<div class="fc-empty">' + esc(tf("league.empty", { code: d.leagueCode })) + "</div>" + assignmentsHtml(coach);
      bindDashboard(); return;
    }
    var thisWeek = d.weekly && d.weekly.length ? d.weekly[d.weekly.length - 1] : 0;
    var fallacyRows = Object.keys(d.fallacyCounts || {}).sort(function (a, b) { return d.fallacyCounts[b] - d.fallacyCounts[a]; }).slice(0, 8).map(function (name) {
      return '<div class="ph-row"><span class="ph-n">' + esc(name) + '</span><span class="ph-score">' + d.fallacyCounts[name] + '×</span>' +
        '<button type="button" class="btn btn-sm" data-learn="' + esc(name) + '">' + esc(t("league.learn")) + "</button></div>";
    }).join("");
    var personaRows = Object.keys(d.personaGroups || {}).map(function (key) {
      var sc = d.personaGroups[key], avg = sc.reduce(function (a, b) { return a + b; }, 0) / sc.length;
      var label = (typeof JUDGE_PERSONAS !== "undefined" && JUDGE_PERSONAS[key]) ? JUDGE_PERSONAS[key].name : t("league.nopersona");
      return '<div class="ph-row"><span class="ph-n">' + esc(label) + '</span><span class="ph-score">' + esc(tf("league.avg", { n: avg.toFixed(1) })) + '</span><span class="ph-stats">' + esc(tf("league.nrounds", { n: sc.length })) + "</span></div>";
    }).join("");
    var studentRows = (d.students || []).map(function (s, i) {
      return "<tr><td>" + esc(s.name) + "</td><td class=\"n\">" + s.rounds + '</td><td class="n">' + s.avgScore + "</td><td>" + esc(s.topFallacy || "–") + "</td><td>" + (s.lastTs ? esc(dateLabel(s.lastTs)) : "–") + "</td>" +
        (coach ? '<td><button type="button" class="btn btn-sm" data-remove="' + i + '">' + esc(t("league.remove")) + "</button></td>" : "") + "</tr>";
    }).join("");
    var recentRows = (d.recent || []).slice(0, 15).map(function (r) {
      return '<div class="ph-row"><span class="ph-n">' + esc(r.studentName) + '</span><span class="ph-score">' + r.scoreA + (r.practiceMode ? "" : " – " + r.scoreB) + ' pts</span><span class="ph-stats">' + esc(r.topic || "") + '</span><span class="ph-date">' + esc(dateLabel(r.ts)) + "</span></div>";
    }).join("");
    resEl.innerHTML = headerHtml(d, coach) +
      '<div class="verdict-card"><div class="verdict-head"><div class="verdict-badge">' + esc(t("league.badge")) + "</div><h3>" + esc(tf("league.stats.rounds", { n: d.totalRounds })) + " · " + esc(tf("league.stats.students", { n: d.uniqueStudents })) + " · " + esc(tf("league.stats.week", { n: thisWeek })) + "</h3></div>" +
      "<h4 class=\"league-h\">" + esc(t("league.weekly")) + "</h4>" + bars(d.weekly || []) + "</div>" +
      assignmentsHtml(coach) +
      '<div class="verdict-card"><div class="verdict-head"><div class="verdict-badge">' + esc(t("league.badge")) + "</div><h3>" + esc(t("league.students")) + "</h3></div>" +
      '<div class="table-wrap"><table class="league-table"><thead><tr><th>' + esc(t("league.col.name")) + '</th><th class="n">' + esc(t("league.col.rounds")) + '</th><th class="n">' + esc(t("league.col.avg")) + "</th><th>" + esc(t("league.col.top")) + "</th><th>" + esc(t("league.col.last")) + "</th>" + (coach ? "<th></th>" : "") + "</tr></thead><tbody>" + studentRows + "</tbody></table></div>" +
      '<div class="lc-actions"><button type="button" class="btn btn-sm" data-csv-students>' + esc(t("league.exportstudents")) + '</button><button type="button" class="btn btn-sm" data-csv-rounds>' + esc(t("league.exportrounds")) + "</button></div></div>" +
      '<div class="verdict-card"><div class="verdict-head"><div class="verdict-badge">' + esc(t("league.badge")) + "</div><h3>" + esc(t("league.fallacies")) + "</h3></div>" +
      '<div class="ph-list">' + (fallacyRows || '<div class="fc-empty">' + esc(t("league.nofallacies")) + "</div>") + "</div>" +
      '<div class="lc-actions"><button type="button" class="btn btn-sm btn-primary" data-practice>' + esc(t("league.practice")) + "</button></div></div>" +
      '<div class="verdict-card"><div class="verdict-head"><div class="verdict-badge">' + esc(t("league.badge")) + "</div><h3>" + esc(t("league.personas")) + "</h3></div><div class=\"ph-list\">" + (personaRows || '<div class="fc-empty">' + esc(t("league.nopersonas")) + "</div>") + "</div></div>" +
      '<div class="verdict-card"><div class="verdict-head"><div class="verdict-badge">' + esc(t("league.badge")) + "</div><h3>" + esc(t("league.recent")) + '</h3></div><div class="ph-list">' + recentRows + "</div></div>";
    bindDashboard();
  }

  function headerHtml(d, coach) {
    return '<div class="league-head"><div><h3>' + esc(d.leagueName || d.leagueCode) + '</h3><span class="lc-label">' + esc(t("league.code")) + ": <b>" + esc(d.leagueCode) + "</b></span></div>" +
      '<div class="league-head-actions">' + (coach ? '<span class="coach-on">' + esc(t("league.coach.on")) + '</span><button type="button" class="btn btn-sm" data-forget>' + esc(t("league.coach.forget")) + "</button>" : "") +
      '<button type="button" class="btn btn-sm" data-sharelink>' + esc(t("league.copylink")) + '</button><button type="button" class="btn btn-sm" data-handout2>' + esc(t("league.handout")) + "</button></div></div>";
  }

  function assignmentsHtml(coach) {
    var list = L.assignments.map(function (a) {
      var done = tf("league.assign.done", { a: a.completed, b: (L.data && L.data.uniqueStudents) || 0 });
      return '<div class="assign-item' + (a.active ? "" : " past") + '"><div class="ai-main"><b>' + esc(a.title) + "</b><span>" + esc(a.topic) + "</span>" +
        (a.note ? '<em>' + esc(a.note) + "</em>" : "") + '<small>' + esc(a.due ? tf("league.assign.dueon", { date: dateLabel(a.due) }) : "") + (a.due ? " · " : "") + esc(done) + "</small></div>" +
        (coach ? '<button type="button" class="btn btn-sm" data-delassign="' + a.id + '">' + esc(t("league.assign.delete")) + "</button>" : "") + "</div>";
    }).join("");
    var form = coach ? '<h4 class="league-h">' + esc(t("league.assign.new")) + '</h4><div class="assign-form">' +
      '<div class="field"><label>' + esc(t("league.assign.titlefield")) + '</label><input id="as-title" type="text" maxlength="80" autocomplete="off" data-lpignore="true" data-1p-ignore="true"></div>' +
      '<div class="field"><label>' + esc(t("league.assign.topic")) + '</label><textarea id="as-topic" rows="2" maxlength="500" autocomplete="off" data-lpignore="true"></textarea></div>' +
      '<div class="field"><label>' + esc(t("league.assign.mode")) + '</label><select id="as-mode" autocomplete="off">' + Object.keys(DEBATE_MODES).filter(function (k) { return k !== "upload"; }).map(function (k) { return '<option value="' + k + '">' + esc(DEBATE_MODES[k].name) + "</option>"; }).join("") + "</select></div>" +
      '<div class="field"><label>' + esc(t("league.assign.due")) + '</label><input id="as-due" type="date" autocomplete="off"></div>' +
      '<div class="field"><label>' + esc(t("league.assign.note")) + '</label><input id="as-note" type="text" maxlength="400" autocomplete="off" data-lpignore="true"></div>' +
      '<button type="button" class="btn btn-primary" id="as-post">' + esc(t("league.assign.post")) + '</button><div class="upload-error" id="as-error" style="display:none"></div></div>' : "";
    return '<div class="verdict-card"><div class="verdict-head"><div class="verdict-badge">' + esc(t("league.badge")) + "</div><h3>" + esc(t("league.assign.title")) + "</h3></div>" +
      (list || '<div class="fc-empty">' + esc(t("league.assign.none")) + "</div>") + form + "</div>";
  }

  function bindDashboard() {
    var res = $("league-results");
    function on(sel, fn) { var el = res.querySelector(sel); if (el) el.addEventListener("click", fn); }
    on("[data-sharelink]", function () { copy(joinLink(L.code)); });
    on("[data-handout2]", function () { printHandout(L.code, L.data.leagueName || L.code); });
    on("[data-forget]", function () { var all = creds(); delete all[L.code]; write(STORE_KEY, all); L.coach = null; renderDashboard(); });
    on("[data-csv-students]", function () {
      download("league-" + L.code + "-students.csv", csv([["Name", "Rounds", "Average score", "Most common fallacy", "Last active"]].concat((L.data.students || []).map(function (s) { return [s.name, s.rounds, s.avgScore, s.topFallacy, s.lastTs || ""]; }))), "text/csv");
    });
    on("[data-csv-rounds]", function () {
      download("league-" + L.code + "-rounds.csv", csv([["Student", "Date", "Format", "Topic", "Practice", "Score A", "Score B", "Fallacies"]].concat((L.data.rounds || []).map(function (r) { return [r.studentName, r.ts || "", r.mode, r.topic, r.practiceMode ? "yes" : "no", r.scoreA, r.scoreB, (r.fallacyNames || []).join("; ")]; }))), "text/csv");
    });
    on("[data-practice]", function () { openStudy("spot", "practice"); });
    res.querySelectorAll("[data-learn]").forEach(function (b) { b.addEventListener("click", function () { openFallacyLibrary(b.getAttribute("data-learn")); }); });
    res.querySelectorAll("[data-remove]").forEach(function (b) {
      b.addEventListener("click", function () {
        var s = L.data.students[parseInt(b.getAttribute("data-remove"), 10)];
        if (!s || !window.confirm(tf("league.remove.confirm", { name: s.name }))) return;
        api("/api/league-remove-student", { code: L.code, coachKey: L.coach.key, studentName: s.name }).then(function (d) { toast(tf("league.removed", { n: d.removed }), "success"); loadLeagueDashboard(L.code); })
          .catch(function (e) { toast(friendlyError(e), "error"); });
      });
    });
    res.querySelectorAll("[data-delassign]").forEach(function (b) {
      b.addEventListener("click", function () {
        api("/api/league-assignment", { code: L.code, coachKey: L.coach.key, action: "delete", id: parseInt(b.getAttribute("data-delassign"), 10) })
          .then(function (d) { L.assignments = d.assignments || []; renderDashboard(); }).catch(function (e) { toast(friendlyError(e), "error"); });
      });
    });
    var post = $("as-post");
    if (post) post.addEventListener("click", function () {
      var err = $("as-error"); err.style.display = "none";
      api("/api/league-assignment", { code: L.code, coachKey: L.coach.key, title: $("as-title").value, topic: $("as-topic").value, mode: $("as-mode").value, due: $("as-due").value, note: $("as-note").value })
        .then(function (d) { L.assignments = d.assignments || []; Stats.feature("league_assignment"); toast(t("league.assign.posted"), "success"); renderDashboard(); })
        .catch(function (e) { err.textContent = friendlyError(e); err.style.display = ""; });
    });
  }

  /* ------------------------------------------------------------------ students: join link + assignment banner in Setup */
  function showAssignment(code) {
    var box = $("league-assign-note");
    if (!box) return;
    code = norm(code);
    if (code.length < 4) { box.innerHTML = ""; return; }
    fetch("/api/league-assignments?code=" + encodeURIComponent(code)).then(function (r) { return r.json(); }).catch(function () { return {}; }).then(function (d) {
      var a = (d.assignments || []).filter(function (x) { return x.active; })[0];
      if (!a) { box.innerHTML = ""; return; }
      box.innerHTML = '<div class="assign-banner"><b>' + esc(tf("league.student.banner", { title: a.title })) + "</b><span>" + esc(a.topic) + "</span>" +
        (a.note ? "<em>" + esc(a.note) + "</em>" : "") + (a.due ? "<small>" + esc(tf("league.assign.dueon", { date: dateLabel(a.due) })) + "</small>" : "") +
        '<button type="button" class="btn btn-sm btn-primary" id="use-assignment">' + esc(t("league.student.use")) + "</button></div>";
      $("use-assignment").addEventListener("click", function () {
        $("custom-topic").value = a.topic;
        if (DEBATE_MODES[a.mode] && state.mode !== a.mode) {
          var name = DEBATE_MODES[a.mode].name;
          Array.prototype.forEach.call(document.querySelectorAll(".mode-card"), function (c) { var h = c.querySelector("h4"); if (h && h.textContent === name) c.click(); });
        }
        $("custom-topic").value = a.topic; // choosing a format can reset the topic box
        toast(t("league.student.used"), "success");
      });
    });
  }

  function initStudent() {
    var input = $("league-code");
    if (!input) return;
    var fromLink = new URLSearchParams(location.search).get("league");
    if (fromLink) {
      input.value = norm(fromLink);
      write(STUDENT_KEY, input.value);
      toast(tf("league.joined", { code: input.value }), "success");
      try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) {}
    } else if (!input.value) {
      var saved = read(STUDENT_KEY); if (saved) input.value = saved;
    }
    input.addEventListener("change", function () { write(STUDENT_KEY, input.value.trim()); showAssignment(input.value); });
    if (input.value) showAssignment(input.value);
  }

  var HASH_SCREENS = { online: "screen-online", learn: "screen-learn" };
  function goHashScreen() {
    var m = /^#(online|learn)$/.exec(location.hash);
    if (m) navTo(HASH_SCREENS[m[1]]);
  }
  document.addEventListener("DOMContentLoaded", function () {
    initStudent();
    if (/^#(league|coach)$/.test(location.hash)) { navTo("screen-league"); var c = $("league-create-card"); if (c) c.scrollIntoView(); }
    goHashScreen();
  });
  window.addEventListener("hashchange", function () { if (/^#(league|coach)$/.test(location.hash)) navTo("screen-league"); goHashScreen(); });
})();
