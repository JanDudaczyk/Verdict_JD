/* Online Debate: the same end-of-speech checking that a local round gets.
   While you speak, sentences are checked live (that code lives in app.html). When your turn ends this
   file does the rest, on your own device, for your own side:
     - checks the last sentences the live check never reached,
     - verifies every claim that was held back (with Wikipedia evidence) and scores it,
     - writes a short coaching review of the turn,
     - and keeps a list of every statement, so the results page can show what was found.
   Scores always go through scoreOnline(), which in a ranked match only accepts AI-made scores.
   Depends on app.html globals: state, t, escapeHtml, friendlyError, groqJSON, fetchWikiContext, buildBacklogPrompt,
   todayRule, SCORED_VERDICTS, VERDICT_GROUP, vlabel, vdesc, claimItemHtml, normalizeReview, pipsHtml,
   runOneOnlineFactCheck, scoreOnline, isTransientCheckError, Stats. */
(function () {
  "use strict";

  var E = { code: null, claims: [], reviews: [], busy: null, jobs: 0 };

  function $(id) { return document.getElementById(id); }
  function backendReady() { var cfg = window.APP_CONFIG || {}; return !!(typeof fcKey === "function" && fcKey()) || !!cfg.PROXY_MODE; }

  function sync(room) {
    if (!room || E.code === room.roomCode) return;
    E.code = room.roomCode; E.claims = []; E.reviews = []; E.busy = null; E.jobs = 0;
    render();
  }

  function pending() { return E.claims.filter(function (c) { return c.verdict === "pending"; }); }

  /* ---------------------------------------------------------------- claims */
  function addClaim(entry) {
    var room = state.onlineRoom;
    if (room) sync(room);
    entry.ts = Date.now();
    E.claims.push(entry);
    renderClaims();
  }

  /* ---------------------------------------------------------------- the end of a turn */
  function endOfTurn(info) {
    // info: { room, side, phaseName, text, topic, leftover: [sentences not yet checked] }
    sync(info.room);
    if (!backendReady()) return;
    E.jobs++;
    var job = (async function () {
      if (info.leftover && info.leftover.length) {
        try { await runOneOnlineFactCheck(info.leftover.join(" "), info.side, { topic: info.topic, final: true }); }
        catch (e) { console.warn("[online] end-of-speech pass failed:", e.message || e); }
      }
      await verifyBacklog(info.side).catch(function () {});
    })().then(function () { E.jobs--; render(); }, function () { E.jobs--; render(); });
    startReview(info);
    return job;
  }

  function buildMyBacklogPrompt(items) { return buildBacklogPrompt(items); }

  function verifyBacklog(side) {
    if (E.busy) return E.busy;
    if (!pending().length || !backendReady()) return Promise.resolve();
    E.busy = (async function () {
      var failures = 0;
      while (pending().length && failures < 2) {
        var batch = pending().slice(0, 5);
        try {
          await Promise.all(batch.map(async function (it) { it.evidence = await fetchWikiContext(it.claim).catch(function () { return []; }); }));
          var r = await groqJSON("You are a careful fact-checker that responds with JSON only, no prose. " + todayRule(),
            buildMyBacklogPrompt(batch), { maxTokens: 1600, effort: "medium" });
          var list = Array.isArray(r && r.results) ? r.results : [];
          batch.forEach(function (it, idx) {
            var res = list.find(function (x) { return Number(x.i) === idx + 1; }) || list[idx] || {};
            var v = String(res.verdict || "").toLowerCase().replace(/[\s-]+/g, "_");
            if (!(SCORED_VERDICTS[v] || v === "inconclusive" || v === "unverifiable")) v = "inconclusive";
            it.verdict = v;
            it.confidence = Math.max(0, Math.min(1, Number(res.confidence) || 0));
            if (SCORED_VERDICTS[v] && it.confidence < ((window.APP_CONFIG || {}).CONSENSUS_BORDERLINE_LOW ?? 0.6)) it.verdict = "inconclusive";
            it.explanation = String(res.explanation || "");
            it.citation = String(res.citation || "");
            it.late = true;
            delete it.evidence;
            if (SCORED_VERDICTS[it.verdict]) scoreClaim(it);
          });
          failures = 0;
        } catch (e) {
          console.warn("[online backlog] batch failed:", e.message || e);
          failures++;
          if (!isTransientCheckError(e.message || e)) break;
          await new Promise(function (res) { setTimeout(res, 2500 * failures); });
        }
        renderClaims();
      }
    })().finally(function () {
      E.busy = null;
      // anything still unchecked is shown as "couldn't be checked" rather than left spinning
      pending().forEach(function (c) { c.verdict = "inconclusive"; c.explanation = c.explanation || t("online.eval.unchecked"); });
      renderClaims();
    });
    return E.busy;
  }

  /* One scored claim -> points. Same weighting as a local round; scoreOnline decides what the server will accept. */
  function scoreClaim(entry) {
    var sc = SCORED_VERDICTS[entry.verdict];
    if (!sc) return;
    var cfg = window.APP_CONFIG || {};
    var minConf = cfg.AUTO_FACTCHECK_CONFIDENCE ?? 0.7;
    var lowB = cfg.CONSENSUS_BORDERLINE_LOW ?? 0.6;
    var conf = entry.confidence || 0;
    var fraction = conf >= minConf ? 1 : (cfg.CONFIDENCE_WEIGHTED_SCORING && conf >= lowB ? +(conf / minConf).toFixed(2) : 0);
    fraction = +(fraction * sc.f).toFixed(2);
    if (fraction <= 0) return;
    scoreOnline(entry.side, sc.type, sc.type === "fact" ? fraction : -fraction, sc.type, true);
  }

  /* ---------------------------------------------------------------- turn reviews */
  function words(s) { return String(s || "").split(/\s+/).filter(Boolean).length; }

  function reviewPrompt(info, opp) {
    var mode = (typeof DEBATE_MODES !== "undefined" && DEBATE_MODES[info.room.mode]) || {};
    var label = (mode.sideLabels && mode.sideLabels[info.side]) || "the speaker";
    return [
      "Coach one speaker after their turn in a debate. Be specific, kind, and brief. You are helping them improve, not ruling on who won.",
      "This is a live speech-to-text transcript: ignore small transcription mistakes, missing punctuation, and filler words. Refer to what they actually said.",
      "Write in " + aiLanguageName() + ".",
      "",
      'Topic: "' + String(info.topic || "").replace(/"/g, "'") + '"',
      "Speaker: " + label + (info.phaseName ? " (" + info.phaseName + ")" : ""),
      opp ? 'Opponent\'s previous turn, for context:\n"""' + opp.replace(/"/g, "'") + '"""' : "",
      'This speaker\'s turn:\n"""' + String(info.text).replace(/"/g, "'") + '"""',
      "",
      'Return ONLY JSON: {"summary":str (<=140 chars: what they argued),"strengths":[str (<=110 chars each)] (1-2),"gaps":[str (<=110 chars each)] (1-2: missing evidence, unclear logic, or an opponent point left unanswered),"answered":"yes"|"partly"|"no"|"n/a","clarity":1-5,"evidence":1-5,"response":0-5,"tip":str (<=130 chars: one concrete thing to do next turn)}'
    ].filter(function (x) { return x !== ""; }).join("\n");
  }

  function startReview(info) {
    var cfg = window.APP_CONFIG || {};
    if (!backendReady() || words(info.text) < (cfg.TURN_REVIEW_MIN_WORDS ?? 25)) return;
    var opp = "";
    var tr = (info.room.transcript || []);
    for (var k = tr.length - 1; k >= 0; k--) {
      if ((tr[k].side === "a" || tr[k].side === "b") && tr[k].side !== info.side && tr[k].text) { opp = String(tr[k].text).slice(0, 1400); break; }
    }
    var rev = { status: "working", phaseName: info.phaseName };
    E.reviews.push(rev);
    Stats.feature("turn_review");
    render();
    (async function () {
      var lastErr = null;
      for (var attempt = 0; attempt < 3; attempt++) {
        try {
          var raw = await groqJSON("You are a kind, sharp debate coach that responds with JSON only, no prose. " + todayRule(),
            reviewPrompt(info, opp), { maxTokens: 1500, effort: "low", lane: "feedback" });
          rev.status = "done"; rev.data = normalizeReview(raw); render(); return;
        } catch (e) {
          lastErr = e;
          if (!isTransientCheckError(e.message || e)) break;
          await new Promise(function (res) { setTimeout(res, 3500 * (attempt + 1)); });
        }
      }
      rev.status = "error"; rev.message = friendlyError(lastErr); render();
    })();
  }

  function reviewHtml(r, open) {
    var head = esc(t("review.title")) + (r.phaseName ? ' <span class="tr-who">' + esc(r.phaseName) + "</span>" : "");
    if (r.status === "working") return '<div class="tr-card working"><div class="tr-head">' + esc(t("review.working")) + (r.phaseName ? ' <span class="tr-who">' + esc(r.phaseName) + "</span>" : "") + "</div></div>";
    if (r.status === "error") return '<div class="tr-card"><div class="tr-head">' + head + '</div><div class="tr-gap">' + esc(r.message || "") + "</div></div>";
    var d = r.data;
    var li = function (a) { return a.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join(""); };
    var ans = { yes: t("review.ans.yes"), partly: t("review.ans.partly"), no: t("review.ans.no"), "n/a": "" }[d.answered];
    return '<details class="tr-card"' + (open ? " open" : "") + '><summary class="tr-head">' + head + '</summary>' +
      '<div class="tr-sum">' + esc(d.summary) + "</div>" +
      '<div class="tr-cols">' +
        (d.strengths.length ? '<div><div class="tr-h">' + esc(t("review.worked")) + "</div><ul>" + li(d.strengths) + "</ul></div>" : "") +
        (d.gaps.length ? '<div><div class="tr-h">' + esc(t("review.missing")) + "</div><ul>" + li(d.gaps) + "</ul></div>" : "") +
      "</div>" +
      '<div class="tr-rates"><span>' + esc(t("review.clarity")) + " " + pipsHtml(d.clarity) + "</span><span>" + esc(t("review.evidence")) + " " + pipsHtml(d.evidence) + "</span>" +
        (d.response ? "<span>" + esc(t("review.response")) + " " + pipsHtml(d.response) + "</span>" : "") +
        (ans ? '<span class="tr-ans">' + esc(ans) + "</span>" : "") + "</div>" +
      (d.tip ? '<div class="tr-tip"><b>' + esc(t("review.tip")) + "</b> " + esc(d.tip) + "</div>" : "") + "</details>";
  }

  function esc(s) { return escapeHtml(String(s == null ? "" : s)); }

  /* ---------------------------------------------------------------- drawing */
  function renderClaims() {
    var box = $("online-final-claims");
    if (!box) return;
    var log = E.claims;
    if (!log.length) { box.innerHTML = ""; return; }
    var counts = {};
    log.forEach(function (c) { var v = c.verdict === "uncertain" ? "inconclusive" : c.verdict; counts[v] = (counts[v] || 0) + 1; });
    var order = ["true", "mostly_true", "misleading", "false", "inconclusive", "opinion", "value", "prediction", "hypothetical", "testimony", "unverifiable", "pending"];
    var chips = order.filter(function (v) { return counts[v]; }).map(function (v) {
      return '<span class="rep-chip verdict-' + v + '" title="' + esc(vdesc(v)) + '">' + esc(vlabel(v)) + " <b>" + counts[v] + "</b></span>";
    }).join("");
    var group = function (c) { return VERDICT_GROUP[c.verdict === "uncertain" ? "inconclusive" : c.verdict] || "facts"; };
    var section = function (g) {
      var rows = log.filter(function (c) { return group(c) === g; });
      if (!rows.length) return "";
      return '<h4 class="rep-h">' + esc(t("claims.report." + g)) + '</h4><div class="rep-list">' +
        rows.map(function (c) { return claimItemHtml(Object.assign({}, c, { side: null })); }).join("") + "</div>";
    };
    var status = (E.busy || E.jobs) ? '<div class="rep-status">' + esc(t("claims.report.working")) + "</div>" : "";
    box.innerHTML = '<h3 class="rep-title">' + esc(t("online.eval.yours")) + '</h3><div class="rep-chips">' + chips + "</div>" + status +
      section("facts") + section("views") + section("unverifiable") + section("pending");
  }

  function renderReviews() {
    var live = $("online-turn-review"), fin = $("online-final-reviews");
    var list = E.reviews;
    if (live) {
      live.innerHTML = list.length ? reviewHtml(list[list.length - 1], true) : "";
    }
    if (fin) {
      fin.innerHTML = list.length ? '<h3 class="rep-title">' + esc(t("online.eval.reviews")) + "</h3>" + list.slice().reverse().map(function (r) { return reviewHtml(r, false); }).join("") : "";
    }
  }

  function render() { renderReviews(); renderClaims(); }

  window.OnlineEval = { sync: sync, addClaim: addClaim, endOfTurn: endOfTurn, render: render, scoreClaim: scoreClaim, state: function () { return E; } };
})();
