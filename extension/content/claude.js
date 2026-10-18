/*
 * clare — claude.ai content script (isolated world).
 * Bridges the page-side fetch observer (inject.js) to the service worker, reads the
 * official usage meter now and then, and shows a calm banner when the weekly budget is
 * close, over, or used up (and, when used up, stops the message from being sent).
 */
(function () {
  "use strict";

  var C = globalThis.ClareCore;
  if (!C || window.top !== window) return;

  var TAG = "__clare_v1__";
  var METER_INTERVAL_MS = 10 * 60 * 1000;

  var state = { paired: false, status: null, statusAt: 0, dismissedFor: null };
  var org = null;
  var convChars = Object.create(null);
  var blocking = false;

  // ── messaging ──────────────────────────────────────────────────────────

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(function () {
        return null;
      });
    } catch (e) {
      return Promise.resolve(null); // extension was reloaded/updated; this page is orphaned
    }
  }

  function toMain(type, payload) {
    var msg = { dir: "to-main", type: type, payload: payload };
    msg[TAG] = true;
    window.postMessage(msg, location.origin);
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (e.source !== window || !d || d[TAG] !== true || d.dir !== "to-isolated") return;
    var p = d.payload || {};
    try {
      if (d.type === "org" && typeof p.org === "string") onOrg(p.org);
      else if (d.type === "conversation") onConversation(p);
      else if (d.type === "completion") onCompletion(p);
      else if (d.type === "blocked-attempt") nudge();
    } catch (err) {}
  });

  function num(x) {
    x = Number(x);
    return isFinite(x) && x >= 0 ? x : 0;
  }

  function onOrg(id) {
    if (org === id) return;
    org = id;
    setTimeout(maybeReadMeter, 5000);
  }

  function onConversation(p) {
    if (typeof p.conv !== "string") return;
    convChars[p.conv] = num(p.chars);
  }

  function onCompletion(p) {
    if (typeof p.conv !== "string") return;
    if (typeof p.org === "string") onOrg(p.org);
    var context = convChars[p.conv] || 0;
    var event = C.estimateEvent({
      conv: p.conv,
      messageUuid: typeof p.messageUuid === "string" ? p.messageUuid : null,
      at: num(p.at) || Date.now(),
      model: typeof p.model === "string" ? p.model : null,
      promptChars: num(p.promptChars),
      outputChars: num(p.outputChars),
      contextChars: context,
      usage: p.usage && typeof p.usage === "object" ? p.usage : null,
    });
    convChars[p.conv] = context + num(p.promptChars) + num(p.outputChars);
    // Always hand it over — the worker knows for sure whether this browser is connected
    // (our own copy of that may not have loaded yet on a fresh tab).
    send({ type: "report", event: event });

    var limits = Array.isArray(p.limits) ? p.limits : [];
    for (var i = 0; i < limits.length; i++) {
      var reading = C.parseMeter(limits[i]);
      if (reading) {
        reading.at = new Date().toISOString();
        send({ type: "meter", reading: reading, org: org });
        break;
      }
    }
    maybeReadMeter();
  }

  // ── official usage meter ───────────────────────────────────────────────

  function maybeReadMeter() {
    if (!org) return;
    // The org goes along so the worker can read the meter on its own when no tab is open.
    send({ type: "meter-slot", org: org }).then(function (r) {
      if (!r || !r.go) return;
      fetch("/api/organizations/" + encodeURIComponent(org) + "/usage", {
        credentials: "include",
        headers: { accept: "application/json" },
      })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        })
        .then(function (json) {
          var reading = C.parseMeter(json);
          if (!reading) throw new Error("unknown shape");
          reading.at = new Date().toISOString();
          send({ type: "meter", reading: reading, org: org });
        })
        .catch(function () {
          send({ type: "meter-failed" });
        });
    });
  }

  setInterval(maybeReadMeter, METER_INTERVAL_MS);

  // ── status ─────────────────────────────────────────────────────────────

  function applyState(s) {
    if (!s) return;
    state.paired = !!s.paired;
    state.status = s.status || null;
    state.statusAt = s.statusAt || 0;
    render();
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    if (!("status" in changes || "token" in changes || "statusAt" in changes)) return;
    send({ type: "get-state" }).then(applyState);
  });

  // Cached state straight from storage first (the worker may be asleep), then a refresh.
  chrome.storage.local.get(["token", "status", "statusAt", "bannerDismissedFor"]).then(function (r) {
    state.dismissedFor = r.bannerDismissedFor || null;
    if (!state.statusAt || (r.statusAt || 0) > state.statusAt) {
      applyState({ paired: !!r.token, status: r.status || null, statusAt: r.statusAt || 0 });
    }
  });
  send({ type: "tab-hello" }).then(applyState);
  setInterval(render, 30 * 1000); // lets a block lift by itself at reset time

  // ── stop sends while blocked ───────────────────────────────────────────

  function inComposer(t) {
    return !!(t && t.closest && t.closest('[contenteditable="true"], textarea'));
  }

  function isSendButton(t) {
    var b = t && t.closest && t.closest("button");
    if (!b) return false;
    var label = (b.getAttribute("aria-label") || "") + " " + (b.getAttribute("data-testid") || "");
    if (/send/i.test(label)) return true;
    var form = b.closest("form, fieldset");
    return b.type === "submit" && !!(form && form.querySelector('[contenteditable="true"], textarea'));
  }

  function stop(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    nudge();
  }

  window.addEventListener(
    "keydown",
    function (e) {
      if (blocking && e.key === "Enter" && !e.shiftKey && !e.isComposing && inComposer(e.target)) stop(e);
    },
    true
  );
  ["click", "pointerdown"].forEach(function (type) {
    window.addEventListener(
      type,
      function (e) {
        if (blocking && isSendButton(e.target)) stop(e);
      },
      true
    );
  });
  window.addEventListener(
    "submit",
    function (e) {
      if (blocking && e.target && e.target.querySelector && e.target.querySelector('[contenteditable="true"], textarea')) stop(e);
    },
    true
  );

  // ── banner (Shadow DOM so claude.ai styles can't touch it) ─────────────

  var host = null;
  var ui = null;
  var collapsed = false;

  var CSS =
    ":host{all:initial}" +
    "*{box-sizing:border-box}" +
    ".wrap{position:fixed;z-index:2147483646;font:15px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;" +
    "--bg:#FFFFFF;--ink:#1C1B1A;--muted:#6B6862;--line:#E8E4DD;--accent:#2F6F5E;--warn:#C98A1B;--bad:#C2453A;--soft:#FBF1EF;color:var(--ink)}" +
    "@media (prefers-color-scheme:dark){.wrap{--bg:#1F1E1C;--ink:#EDEBE7;--muted:#A29F98;--line:#2E2C29;--accent:#5FB39B;--soft:#2A1F1D}}" +
    ".card{background:var(--bg);border:1px solid var(--line);border-radius:14px;padding:14px 16px;display:flex;gap:12px;align-items:flex-start;" +
    "box-shadow:0 8px 28px rgba(0,0,0,.12)}" +
    ".card.bad{border-color:color-mix(in srgb,var(--bad) 35%,var(--line))}" +
    ".ring{flex:none;margin-top:2px}" +
    ".title{font-weight:650;margin:0 0 2px}" +
    ".msg{margin:0;color:var(--muted)}" +
    ".btn{all:unset;cursor:pointer;margin-left:auto;flex:none;font-weight:600;color:var(--accent);padding:4px 6px;border-radius:8px}" +
    ".btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}" +
    ".pill{display:inline-flex;align-items:center;gap:8px;background:var(--bg);border:1px solid var(--line);border-radius:999px;" +
    "padding:6px 8px 6px 12px;box-shadow:0 4px 16px rgba(0,0,0,.10);font-size:14px}" +
    ".pill .dot{width:8px;height:8px;border-radius:50%;background:var(--warn)}" +
    ".pill.bad .dot{background:var(--bad)}" +
    ".x{all:unset;cursor:pointer;width:22px;height:22px;display:grid;place-items:center;border-radius:50%;color:var(--muted);font-size:16px}" +
    ".x:hover{background:var(--line)}" +
    "@keyframes nudge{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}" +
    ".nudge{animation:nudge .28s ease-in-out 2}" +
    "@media (prefers-reduced-motion:reduce){.nudge{animation:none}}";

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement("clare-banner");
    var root = host.attachShadow({ mode: "closed" });
    var style = document.createElement("style");
    style.textContent = CSS;
    var wrap = document.createElement("div");
    wrap.className = "wrap";
    wrap.setAttribute("role", "status");
    wrap.setAttribute("aria-live", "polite");
    root.appendChild(style);
    root.appendChild(wrap);
    ui = wrap;
    (document.body || document.documentElement).appendChild(host);
  }

  function ringSvg(color) {
    return (
      '<svg class="ring" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">' +
      '<circle cx="11" cy="11" r="8" fill="none" stroke="' +
      color +
      '" stroke-width="3.2"/></svg>'
    );
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function composerRect() {
    var nodes = document.querySelectorAll('[contenteditable="true"], textarea');
    for (var i = nodes.length - 1; i >= 0; i--) {
      var r = nodes[i].getBoundingClientRect();
      if (r.width > 200 && r.height > 0 && r.top > window.innerHeight * 0.3) return r;
    }
    return null;
  }

  function place() {
    if (!ui) return;
    var r = composerRect();
    var width = Math.min(r ? Math.max(r.width, 320) : 640, window.innerWidth - 32);
    var left = r ? Math.min(Math.max(16, r.left + (r.width - width) / 2), window.innerWidth - width - 16) : (window.innerWidth - width) / 2;
    var bottom = r ? Math.max(16, window.innerHeight - r.top + 12) : 120;
    ui.style.left = left + "px";
    ui.style.width = width + "px";
    ui.style.bottom = bottom + "px";
    ui.style.display = "flex";
    ui.style.justifyContent = "center";
  }

  var placeTimer = null;

  function hide() {
    if (ui) ui.innerHTML = "";
    if (placeTimer) {
      clearInterval(placeTimer);
      placeTimer = null;
    }
  }

  function show(html) {
    ensureHost();
    ui.innerHTML = html;
    place();
    if (!placeTimer) placeTimer = setInterval(place, 800);
    var btn = ui.querySelector("[data-act]");
    if (btn)
      btn.addEventListener("click", function () {
        var act = btn.getAttribute("data-act");
        if (act === "collapse") {
          collapsed = true;
          render();
        } else if (act === "expand") {
          collapsed = false;
          render();
        } else if (act === "dismiss") {
          state.dismissedFor = noticeKey(state.status);
          chrome.storage.local.set({ bannerDismissedFor: state.dismissedFor });
          render();
        }
      });
  }

  function render() {
    var s = state.status;
    blocking = state.paired && C.isBlocking(s, state.statusAt, Date.now());
    toMain("status", { blocked: blocking });
    if (!document.documentElement) return;
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", render, { once: true });
      return;
    }

    if (blocking) {
      var device = s.scope === "device";
      var title = s.scope === "group" && s.group
        ? C.groupPhrase(s.group.label).replace(/^t/, "T") + "'s weekly Claude share is used up"
        : device ? "This browser's weekly Claude budget is used up" : "This week's Claude budget is used up";
      if (collapsed) {
        show(
          '<div class="pill bad"><span class="dot"></span><span>' +
            esc(C.shortLine(s)) +
            '</span><button class="x" data-act="expand" aria-label="Show details">i</button></div>'
        );
      } else {
        show(
          '<div class="card bad">' +
            ringSvg("var(--bad)") +
            '<div><p class="title">' +
            esc(title) +
            '</p><p class="msg">' +
            esc(C.bannerText(s)) +
            '</p></div><button class="btn" data-act="collapse">Got it</button></div>'
        );
      }
      return;
    }

    if (state.paired && s && (s.state === "warn" || s.state === "over") && state.dismissedFor !== noticeKey(s)) {
      var scope = s.scope === "group" && s.group
        ? C.groupPhrase(s.group.label) + "'s weekly share"
        : s.scope === "device" ? "this browser's weekly budget" : "this week's budget";
      var text =
        s.state === "over"
          ? "Over " + scope + " (monitor only, nothing is blocked)"
          : "You've used " + C.pctLabel(s.pct) + " of " + scope;
      show(
        '<div class="pill' +
          (s.state === "over" ? " bad" : "") +
          '"><span class="dot"></span><span>' +
          esc(text) +
          '</span><button class="x" data-act="dismiss" aria-label="Dismiss">×</button></div>'
      );
      return;
    }
    hide();
  }

  /** A dismissed pill stays dismissed for that state until the week resets. */
  function noticeKey(s) {
    return s ? s.state + "|" + s.resets_at : null;
  }

  function nudge() {
    if (!blocking) return;
    collapsed = false;
    render();
    var el = ui && ui.firstElementChild;
    if (!el) return;
    el.classList.remove("nudge");
    void el.offsetWidth;
    el.classList.add("nudge");
  }

  window.addEventListener("resize", function () {
    if (ui && ui.innerHTML) place();
  });
})();
