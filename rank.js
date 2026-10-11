/* Ranked play for Online Debate: Casual (no rating change) or Ranked (an AI judge picks the winner
   and both players' Elo ratings move). Everyone starts at 1000 and shows as "Unranked" until their
   first 5 placement matches are done. Tiers: Bronze, Iron, Silver, Gold, Platinum, Diamond, Champion.

   The judge, the rating maths and the leaderboard all live on the server (api/index.py). This file
   only draws things: the rank chip in the header, the rank card in the Online lobby, the Casual /
   Ranked choice when hosting, and the result panel when a match ends.
   Depends on app.html globals: state, t, escapeHtml, toast, navTo, Stats, DEBATE_MODES. */
(function () {
  "use strict";

  var TIERS = [
    { name: "Bronze", floor: 0, color: "#CD7F32" },
    { name: "Iron", floor: 900, color: "#8A8F98" },
    { name: "Silver", floor: 1050, color: "#C0C0C0" },
    { name: "Gold", floor: 1200, color: "#FFC107" },
    { name: "Platinum", floor: 1350, color: "#5FD3C8" },
    { name: "Diamond", floor: 1500, color: "#62A8FF" },
    { name: "Champion", floor: 1700, color: "#E5252A" }
  ];
  var TOTAL_PLACEMENTS = 5;
  var R = { pause: null, pauseTimer: null, wasPaused: false, card: null, history: [], board: [], boardAt: 0, loadedFor: null, loading: false, judging: {}, results: {}, tries: {}, announced: {}, shownFor: null };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return escapeHtml(String(s == null ? "" : s)); }
  function tf(key, vars) {
    var s = t(key);
    if (vars) Object.keys(vars).forEach(function (k) { s = s.split("{" + k + "}").join(vars[k]); });
    return s;
  }
  function tierIndex(name) { for (var i = 0; i < TIERS.length; i++) if (TIERS[i].name === name) return i; return -1; }
  function authed() { return !!(state.authToken && state.authUser); }
  function headers() { return { "Content-Type": "application/json", Authorization: "Bearer " + state.authToken }; }
  function signed(n) { return (n > 0 ? "+" : n < 0 ? "−" : "±") + Math.abs(n); }

  /* ---------------------------------------------------------------- the badge */
  function badge(tier, px) {
    var i = tierIndex(tier);
    var fill = i < 0 ? "#E4DFB8" : TIERS[i].color;
    var letter = i < 0 ? "?" : tier.charAt(0);
    var crown = tier === "Champion" ? '<path d="M11 14 L15 2 L24 10 L33 2 L37 14 Z" fill="' + fill + '" stroke="#000" stroke-width="3" stroke-linejoin="miter"/>' : "";
    return '<svg class="rank-badge" width="' + px + '" height="' + Math.round(px * 1.17) + '" viewBox="0 0 48 56" role="img" aria-label="' + esc(i < 0 ? t("rank.unranked") : tier) + '">' +
      crown +
      '<path d="M24 6 L44 13 V29 C44 41 35 50 24 54 C13 50 4 41 4 29 V13 Z" fill="' + fill + '" stroke="#000" stroke-width="3" stroke-linejoin="miter"/>' +
      '<text x="24" y="38" text-anchor="middle" font-family="Archivo, Arial, sans-serif" font-weight="900" font-size="26" fill="#000">' + letter + '</text></svg>';
  }

  /* ---------------------------------------------------------------- loading */
  function loadMe(force) {
    if (!authed()) { R.card = null; R.history = []; R.loadedFor = null; renderChip(); return Promise.resolve(); }
    if (!force && (R.loadedFor === state.authToken || R.loading)) return Promise.resolve();
    R.loading = true;
    return fetch("/api/rank-me", { headers: headers() }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        if (x.ok && x.d.rank) { R.card = x.d.rank; R.history = x.d.history || []; R.loadedFor = state.authToken; }
      }).catch(function () {}).then(function () { R.loading = false; renderChip(); renderLobby(); });
  }

  function loadBoard(force) {
    if (!force && R.board.length && Date.now() - R.boardAt < 60000) return Promise.resolve();
    return fetch("/api/rank-leaderboard").then(function (r) { return r.json(); }).then(function (d) {
      R.board = d.players || []; R.boardAt = Date.now(); renderLobby();
    }).catch(function () {});
  }

  /* ---------------------------------------------------------------- header chip */
  function renderChip() {
    var area = $("account-area");
    if (!area) return;
    var old = $("rank-chip");
    if (old) old.remove();
    if (!authed() || !R.card) return;
    var c = R.card;
    var chip = document.createElement("button");
    chip.type = "button";
    chip.id = "rank-chip";
    chip.className = "rank-chip";
    chip.title = t("rank.chip.title");
    chip.setAttribute("onclick", "navTo('screen-online')");
    chip.innerHTML = badge(c.placed ? c.tier : null, 18) + "<span>" + esc(c.placed ? c.tier : t("rank.unranked")) + "</span>";
    var name = area.querySelector(".account-name");
    if (name && name.nextSibling) area.insertBefore(chip, name.nextSibling); else area.appendChild(chip);
  }

  /* ---------------------------------------------------------------- the lobby card */
  function ago(iso) {
    var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (isNaN(s)) return "";
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + " min";
    if (s < 86400) return Math.round(s / 3600) + " h";
    return Math.round(s / 86400) + " d";
  }

  function progressBar(c) {
    if (!c.placed) {
      var dots = "";
      for (var i = 0; i < TOTAL_PLACEMENTS; i++) dots += '<i class="' + (i < c.games ? "on" : "") + '"></i>';
      return '<div class="rank-dots" aria-hidden="true">' + dots + "</div><p class=\"rank-sub\">" +
        esc(tf("rank.placement", { n: c.games, total: TOTAL_PLACEMENTS })) + " " + esc(tf("rank.placement.note", { n: c.placementsLeft })) + "</p>";
    }
    if (!c.next) return '<p class="rank-sub">' + esc(t("rank.top")) + "</p>";
    return '<div class="rank-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(c.progress * 100) + '"><i style="width:' + Math.round(c.progress * 100) + '%"></i></div>' +
      '<p class="rank-sub">' + esc(tf("rank.next", { n: Math.max(1, c.nextAt - c.rating), tier: c.next })) + "</p>";
  }

  function renderLobby() {
    var host = $("rank-card");
    if (!host) return;
    if (!authed()) { host.innerHTML = ""; return; }
    var c = R.card;
    if (!c) { host.innerHTML = '<p class="rank-sub">' + esc(t("rank.loading")) + "</p>"; return; }
    var recent = (R.history || []).slice(0, 5).map(function (m) {
      var word = m.result === "win" ? t("rank.result.won") : m.result === "loss" ? t("rank.result.lost") : t("rank.result.draw");
      return '<li class="' + esc(m.result) + '"><b>' + esc(word) + "</b><span>" + esc(m.opponent || "") + "</span><em>" + esc(signed(m.delta)) + "</em><small>" + esc(ago(m.ts)) + "</small></li>";
    }).join("");
    var board = (R.board || []).slice(0, 10).map(function (p) {
      return "<li><b>" + p.rank + "</b>" + badge(p.tier, 16) + "<span>" + esc(p.name || t("rank.board.anon")) + "</span><em>" + p.rating + "</em></li>";
    }).join("");
    host.innerHTML =
      '<div class="rank-top">' +
        '<div class="rank-badge-wrap">' + badge(c.placed ? c.tier : null, 64) + "</div>" +
        '<div class="rank-main">' +
          '<div class="rank-tier">' + esc(c.placed ? c.tier : t("rank.unranked")) + "</div>" +
          (c.placed ? '<div class="rank-rating">' + esc(tf("rank.rating", { n: c.rating })) + " · " + esc(tf("rank.peak", { n: c.peak })) + "</div>" : "") +
          '<div class="rank-record">' + esc(tf("rank.record", { w: c.wins, l: c.losses, d: c.draws })) + "</div>" +
        "</div>" +
      "</div>" +
      progressBar(c) +
      '<details class="rank-how"><summary>' + esc(t("rank.how.title")) + "</summary><p>" + esc(t("rank.how.body")) + "</p><p>" + esc(t("rank.how.rules")) + "</p></details>" +
      '<h4 class="rank-h">' + esc(t("rank.recent")) + "</h4>" +
      (recent ? '<ul class="rank-list">' + recent + "</ul>" : '<p class="rank-sub">' + esc(t("rank.none")) + "</p>") +
      '<h4 class="rank-h">' + esc(t("rank.board")) + "</h4>" +
      (board ? '<ol class="rank-board">' + board + "</ol>" : '<p class="rank-sub">' + esc(t("rank.board.empty")) + "</p>") +
      '<label class="rank-opt"><input type="checkbox" id="rank-show" autocomplete="off"' + (c.showOnBoard ? " checked" : "") + '> <span>' + esc(t("rank.board.show")) + "</span></label>" +
      '<p class="rank-sub">' + esc(t("rank.board.showdesc")) + "</p>";
    var box = $("rank-show");
    if (box) box.addEventListener("change", function () {
      var want = box.checked;
      fetch("/api/rank-settings", { method: "POST", headers: headers(), body: JSON.stringify({ showOnBoard: want }) })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (d && d.ok && R.card) { R.card.showOnBoard = want; loadBoard(true); } else { box.checked = !want; } })
        .catch(function () { box.checked = !want; });
    });
  }

  /* ---------------------------------------------------------------- hosting: Casual or Ranked */
  function wantsRanked() {
    var el = document.querySelector('input[name="online-queue"]:checked');
    return !!(el && el.value === "ranked");
  }
  function syncQueueChoice() {
    document.querySelectorAll(".queue-opt").forEach(function (l) {
      var i = l.querySelector("input");
      l.classList.toggle("on", !!(i && i.checked));
    });
  }

  /* ---------------------------------------------------------------- inside a room */
  function sideLabel(room) { return room.ranked ? t("rank.ranked") : t("rank.casual"); }

  function setFlags(room) {
    ["online-ranked-flag", "online-waiting-flag"].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.hidden = false;
      el.textContent = sideLabel(room);
      el.classList.toggle("ranked", !!room.ranked);
    });
  }

  function resultHtml(room, res) {
    var me = room.yourSide;
    if (res.status !== "rated") {
      var key = res.why === "short" ? "rank.void.short" : res.why === "repeat" ? "rank.void.repeat" : "rank.void.unavailable";
      return '<div class="rank-result void"><div class="rank-result-head"><b>' + esc(t("rank.void.title")) + "</b></div><p>" + esc(t(key)) + "</p></div>";
    }
    var mine = res[me] || res.a;
    var outcome = res.winner === "tie" ? "draw" : (res.winner === me ? "win" : "loss");
    var word = outcome === "win" ? t("rank.result.won") : outcome === "loss" ? t("rank.result.lost") : t("rank.result.draw");
    var notes = [];
    if (mine.placementGame) notes.push(tf("rank.result.placement", { n: mine.placementGame, total: TOTAL_PLACEMENTS }));
    if (!mine.tierBefore && mine.tierAfter) notes.push(tf("rank.result.placed", { tier: mine.tierAfter }));
    else if (mine.tierBefore && mine.tierAfter && mine.tierBefore !== mine.tierAfter) {
      notes.push(tf(tierIndex(mine.tierAfter) > tierIndex(mine.tierBefore) ? "rank.result.promoted" : "rank.result.demoted", { tier: mine.tierAfter }));
    }
    var shownTier = mine.tierAfter || null;
    var rubric = "";
    if (res.rubric && res.rubric.a && res.rubric.b) {
      var other = me === "a" ? "b" : "a";
      var rows = ["argument", "evidence", "rebuttal", "clarity"].map(function (k) {
        return "<tr><th scope=\"row\">" + esc(t("rank.rubric." + k)) + "</th><td>" + pipsHtml(res.rubric[me][k]) + "</td><td>" + pipsHtml(res.rubric[other][k]) + "</td></tr>";
      }).join("");
      rubric = '<table class="rank-rubric"><caption>' + esc(t("rank.rubric.title")) + "</caption><thead><tr><td></td><th scope=\"col\">" + esc(mine.name || "") + "</th><th scope=\"col\">" + esc((res[other] || {}).name || "") + "</th></tr></thead><tbody>" + rows + "</tbody></table>";
    }
    return '<div class="rank-result ' + outcome + '">' +
      '<div class="rank-result-head">' + badge(shownTier, 44) + "<div><b>" + esc(word) + "</b>" +
      (shownTier ? "<span>" + esc(shownTier) + "</span>" : "<span>" + esc(t("rank.unranked")) + "</span>") + "</div></div>" +
      '<div class="rank-result-delta"><span>' + esc(mine.before) + "</span> → <span>" + esc(mine.after) + "</span> <em>" + esc(signed(mine.delta)) + "</em></div>" +
      notes.map(function (n) { return '<p class="rank-result-note">' + esc(n) + "</p>"; }).join("") +
      (res.reason ? '<p class="rank-result-why"><b>' + esc(t("rank.judge.reason")) + "</b> " + esc(res.reason) + "</p>" : "") +
      rubric + "</div>";
  }

  function paintResult(room, res) {
    var box = $("online-rank-result");
    if (!box) return;
    box.innerHTML = resultHtml(room, res);
    box.hidden = false;
    if (res.status === "rated") loadMe(true).then(function () { loadBoard(true); });
  }

  function paintJudging(msgKey, retry) {
    var box = $("online-rank-result");
    if (!box) return;
    box.hidden = false;
    box.innerHTML = '<div class="rank-result pending"><div class="spinner"></div><p>' + esc(t(msgKey)) + "</p>" +
      (retry ? '<button class="btn btn-sm" type="button" id="rank-judge-retry">' + esc(t("rank.judge.again")) + "</button>" : "") + "</div>";
    var b = $("rank-judge-retry");
    if (b) b.addEventListener("click", function () { var rm = state.onlineRoom; if (rm) { R.tries[rm.roomCode] = 0; fetchResult(rm); } });
  }

  function fetchResult(room) {
    var code = room.roomCode;
    if (R.judging[code]) return;
    R.judging[code] = true;
    R.tries[code] = (R.tries[code] || 0) + 1;
    paintJudging("rank.judging");
    fetch("/api/room-result", { method: "POST", headers: headers(), body: JSON.stringify({ roomCode: code }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
      .then(function (x) {
        R.judging[code] = false;
        var cur = state.onlineRoom;
        if (x.ok && x.d.result) {
          R.results[code] = x.d.result;
          if (cur && cur.roomCode === code) paintResult(cur, x.d.result);
          Stats.feature("ranked_match");
          return;
        }
        if (x.ok && x.d.ranked === false) return;
        if (R.tries[code] < 12) setTimeout(function () { var rm = state.onlineRoom; if (rm && rm.roomCode === code) fetchResult(rm); }, x.d && x.d.pending ? 2500 : 4000);
        else if (cur && cur.roomCode === code) paintJudging("rank.judge.slow", true);
      })
      .catch(function () {
        R.judging[code] = false;
        if (R.tries[code] < 12) setTimeout(function () { var rm = state.onlineRoom; if (rm && rm.roomCode === code) fetchResult(rm); }, 4000);
        else paintJudging("rank.judge.slow", true);
      });
  }

  /* ---------------------------------------------------------------- ranked rules shown during the debate */
  function renderAgree(room) {
    var el = $("online-agree");
    if (!el) return;
    var p = room.ranked ? room.proposal : null;
    if (!p) { el.hidden = true; el.innerHTML = ""; el.dataset.sig = ""; return; }
    var sig = [p.kind, p.by, p.side, p.type, room.yourSide].join("|");
    if (el.dataset.sig === sig && !el.hidden) return;
    el.dataset.sig = sig;
    var me = room.yourSide;
    var mine = p.by === me;
    var byName = p.by === "a" ? room.hostName : (room.guestName || "");
    var oppName = me === "a" ? (room.guestName || "") : room.hostName;
    var text;
    if (p.kind === "end") text = mine ? tf("rank.agree.wait.end", { name: oppName }) : tf("rank.agree.end.ask", { name: byName });
    else {
      var target = p.side === "a" ? room.hostName : (room.guestName || "");
      text = mine ? tf("rank.agree.wait.score", { name: oppName }) : tf("rank.agree.score.ask", { name: byName, target: target, kind: t("rank.agree.kind." + p.type) });
    }
    el.innerHTML = "<span>" + esc(text) + "</span>" + (mine
      ? '<button type="button" class="btn btn-sm" data-agree="no">' + esc(t("rank.agree.cancel")) + "</button>"
      : '<button type="button" class="btn btn-sm btn-primary" data-agree="yes">' + esc(t("rank.agree.yes")) + '</button><button type="button" class="btn btn-sm" data-agree="no">' + esc(t("rank.agree.no")) + "</button>");
    el.hidden = false;
    el.querySelectorAll("[data-agree]").forEach(function (b) {
      b.addEventListener("click", function () { respondOnline(b.getAttribute("data-agree") === "yes"); });
    });
  }

  function paintPause() {
    var pz = R.pause;
    var note = $("online-pause-note"), btn = $("online-btn-pause");
    if (!pz || !note) return;
    var left = pz.paused ? Math.max(0, pz.left - (Date.now() - pz.at) / 1000) : pz.left;
    note.hidden = false;
    note.textContent = pz.paused ? tf("rank.pause.note", { n: Math.ceil(left) }) : t("rank.pause.rule");
    if (btn) {
      btn.textContent = left > 0 ? tf("rank.pause.left", { n: Math.ceil(left) }) : t("rank.pause.none");
      if (left <= 0) btn.disabled = true;
    }
  }

  function renderPause(room) {
    var note = $("online-pause-note");
    if (!room.ranked || !room.pause) {
      if (note) note.hidden = true;
      R.pause = null; R.pauseSrc = null;
      if (R.pauseTimer) { clearInterval(R.pauseTimer); R.pauseTimer = null; }
      return;
    }
    var pz = room.pause;
    // Each poll brings a fresh pause object; re-renders in between must not restart the local countdown.
    if (R.pauseSrc !== pz) { R.pauseSrc = pz; R.pause = { left: pz.left, paused: pz.paused, at: Date.now() }; }
    paintPause();
    if (pz.paused && !R.pauseTimer) R.pauseTimer = setInterval(paintPause, 1000);
    if (!pz.paused && R.pauseTimer) { clearInterval(R.pauseTimer); R.pauseTimer = null; }
    // The server restarts the clock by itself when the pause runs out; the speaker's microphone has to follow.
    var mine = !!room.yourSide && room.currentSide === room.yourSide;
    if (R.wasPaused && room.timerRunning && mine && !state.onlineRecog && typeof startOnlineMic === "function") startOnlineMic();
    R.wasPaused = !!pz.paused;
  }

  function renderActive(room) {
    var note = $("online-score-note");
    if (note) note.hidden = !room.ranked;
    renderAgree(room);
    renderPause(room);
  }

  function onRoom(room) {
    if (!room) return;
    setFlags(room);
    if (room.status === "active") renderActive(room);
    else { renderAgree({ ranked: false }); renderPause({ ranked: false }); var sn = $("online-score-note"); if (sn) sn.hidden = true; }
    if (room.status === "active" && room.ranked && !R.announced[room.roomCode]) {
      R.announced[room.roomCode] = true;
      if (room.yourSide === "b") toast(t("rank.notice.joined"), "warn");
    }
    var box = $("online-rank-result");
    if (room.status !== "ended") { if (box) { box.hidden = true; box.innerHTML = ""; } return; }
    if (!box) return;
    if (!room.ranked) {
      box.hidden = false;
      box.innerHTML = '<div class="rank-result casual"><p>' + esc(t("rank.casual.note")) + "</p></div>";
      return;
    }
    var done = room.result || R.results[room.roomCode];
    if (done) {
      if (R.shownFor !== room.roomCode) { R.shownFor = room.roomCode; paintResult(room, done); }
      return;
    }
    fetchResult(room);
  }

  // A ranked match that just ended still needs its result decided even if this player leaves right away.
  function beforeLeave() {
    var room = state.onlineRoom;
    if (room && room.ranked && room.status === "ended" && !room.result && !R.results[room.roomCode] && state.authToken) {
      try { fetch("/api/room-result", { method: "POST", headers: headers(), body: JSON.stringify({ roomCode: room.roomCode }), keepalive: true }).catch(function () {}); } catch (e) {}
    }
  }

  /* ---------------------------------------------------------------- hooks into app.html */
  function wrap(name, after, before) {
    var orig = window[name];
    if (typeof orig !== "function") return;
    window[name] = function () {
      if (before) before.apply(this, arguments);
      var out = orig.apply(this, arguments);
      if (after) after.apply(this, arguments);
      return out;
    };
  }

  wrap("updateAccountUI", function () { if (!authed()) { R.card = null; R.history = []; R.loadedFor = null; } renderChip(); loadMe(false); });
  wrap("renderOnlineScreen", function () {
    if (!authed()) return;
    renderLobby();
    if (!state.onlineRoom) { loadMe(true); loadBoard(false); syncQueueChoice(); }
  });
  wrap("renderOnlineRoom", function () { onRoom(state.onlineRoom); });
  wrap("leaveOnlineRoom", null, beforeLeave);
  wrap("setUILang", function () { renderChip(); renderLobby(); var rm = state.onlineRoom; if (rm && rm.status === "ended") { R.shownFor = null; onRoom(rm); } });

  document.addEventListener("change", function (e) { if (e.target && e.target.name === "online-queue") syncQueueChoice(); });
  document.addEventListener("DOMContentLoaded", function () { syncQueueChoice(); });

  window.Rank = { wantsRanked: wantsRanked, badge: badge, refresh: function () { return loadMe(true); }, state: function () { return R; } };
})();
