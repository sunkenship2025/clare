/*
 * clare core — pure helpers used by the service worker, the claude.ai content script,
 * the popup and tests. (What runs inside claude.ai's own page lives in lib/page.js.)
 * Plain script: attaches `ClareCore` to the global object, and to module.exports under Node.
 * No DOM, no chrome.* — keep it that way so it stays testable.
 */
(function (root) {
  "use strict";

  // ── Usage events ─────────────────────────────────────────────────────────

  var CHARS_PER_TOKEN = 4;
  // claude.ai sends a system prompt every turn; it is almost always a cache hit.
  var SYSTEM_TOKENS = 2000;

  function tokens(chars) {
    return Math.ceil(Math.max(0, Number(chars) || 0) / CHARS_PER_TOKEN);
  }

  /**
   * Usage event for /report. Estimates from character counts unless the stream
   * carried real token usage.
   *   input       = the new prompt (uncached)
   *   cache_read  = known prior conversation + system prompt
   *   output      = response text incl. thinking and tool input
   */
  function estimateEvent(o) {
    var at = new Date(o.at || Date.now());
    var key = "web:" + (o.conv || "unknown") + ":" + (o.messageUuid || at.getTime());
    var u = o.usage;
    if (u && u.has_input && u.has_output) {
      return {
        key: key,
        model: o.model || "unknown",
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cache_read: u.cache_read_input_tokens || 0,
        cache_write: u.cache_creation_input_tokens || 0,
        cache_write_1h: 0,
        at: at.toISOString(),
        estimated: false,
      };
    }
    return {
      key: key,
      model: o.model || "unknown",
      input: tokens(o.promptChars),
      output: u && u.has_output ? u.output_tokens || 0 : tokens(o.outputChars),
      cache_read: tokens(o.contextChars) + SYSTEM_TOKENS,
      cache_write: 0,
      cache_write_1h: 0,
      at: at.toISOString(),
      estimated: true,
    };
  }

  /** Keep only well-formed events (anything crossing from the page is untrusted). */
  function sanitizeEvent(e) {
    if (!e || typeof e !== "object" || typeof e.key !== "string" || !e.key || e.key.length > 200) return null;
    function n(x) {
      x = Number(x);
      return isFinite(x) && x >= 0 ? Math.min(Math.round(x), 50000000) : 0;
    }
    var at = Date.parse(e.at);
    return {
      key: e.key,
      model: typeof e.model === "string" ? e.model.slice(0, 100) : "unknown",
      input: n(e.input),
      output: n(e.output),
      cache_read: n(e.cache_read),
      cache_write: n(e.cache_write),
      cache_write_1h: n(e.cache_write_1h),
      at: new Date(isFinite(at) ? at : Date.now()).toISOString(),
      estimated: e.estimated !== false,
    };
  }

  /** Add events to a pending queue: dedupe by key (latest wins), keep the newest `cap`. */
  function queueAdd(queue, events, cap) {
    cap = cap || 1000;
    var map = Object.create(null);
    var order = [];
    var all = (queue || []).concat(events || []);
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (!e || !e.key) continue;
      if (!(e.key in map)) order.push(e.key);
      map[e.key] = e;
    }
    var out = order.map(function (k) {
      return map[k];
    });
    return out.length > cap ? out.slice(out.length - cap) : out;
  }

  // ── Official usage meter ─────────────────────────────────────────────────

  var WEEK_KEYS = ["seven_day", "sevenDay", "7d", "weekly", "week"];
  var FIVE_KEYS = ["five_hour", "fiveHour", "5h", "session"];

  function normTime(v) {
    if (v === null || v === undefined || v === "") return null;
    var ms;
    if (typeof v === "number") ms = v > 1e12 ? v : v * 1000;
    else ms = Date.parse(String(v));
    return isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
  }

  function normWindow(w) {
    if (!w || typeof w !== "object") return null;
    var u = w.utilization !== undefined ? w.utilization : w.pct;
    if (typeof u === "string") u = parseFloat(u);
    if (typeof u !== "number" || !isFinite(u) || u < 0) return null;
    var resets = normTime(w.resets_at !== undefined ? w.resets_at : w.resetsAt);
    // claude.ai reports a percentage (0–100), which is what the canonical reading's `pct` is.
    return { pct: u, resets_at: resets };
  }

  function findWindows(node, depth) {
    if (!node || typeof node !== "object" || depth > 4) return null;
    var week = null;
    var five = null;
    var i;
    for (i = 0; i < WEEK_KEYS.length && !week; i++) week = normWindow(node[WEEK_KEYS[i]]);
    for (i = 0; i < FIVE_KEYS.length && !five; i++) five = normWindow(node[FIVE_KEYS[i]]);
    if (week && week.resets_at) return { week: week, five: five };
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      var v = node[k];
      if (v && typeof v === "object") {
        var found = findWindows(v, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Parse a usage payload (claude.ai usage endpoint or a message_limit event) into the
   * canonical reading `{ seven_day: {pct, resets_at}, five_hour?: {pct, resets_at} }`, or null.
   * The caller stamps `at` when it sends it.
   */
  function parseMeter(json) {
    var w = findWindows(json, 0);
    if (!w) return null;
    var out = { seven_day: w.week };
    if (w.five && w.five.resets_at) out.five_hour = w.five;
    return out;
  }

  /** A reading that crossed from a content script, made safe for POST /meter. Null if unusable. */
  function cleanReading(r, now) {
    if (!r || typeof r !== "object") return null;
    var week = normWindow(r.seven_day);
    if (!week || !week.resets_at) return null;
    var at = Date.parse(r.at);
    now = now || Date.now();
    var out = {
      at: new Date(isFinite(at) && at <= now ? at : now).toISOString(),
      seven_day: week,
    };
    var five = normWindow(r.five_hour);
    if (five && five.resets_at) out.five_hour = five;
    return out;
  }

  // ── Status → words ───────────────────────────────────────────────────────

  var DAY = 24 * 3600 * 1000;

  /**
   * Should the browser refuse to send? The cached-policy rule: only a status that says
   * "blocked", whose week hasn't reset yet, and that is less than a day old. Anything
   * else (no status, "over" in monitor-only mode, a stale cache) lets the message through.
   */
  function isBlocking(status, statusAt, now) {
    if (!status || status.state !== "blocked") return false;
    now = now || Date.now();
    if (!statusAt || now - statusAt >= DAY) return false;
    var r = Date.parse(status.resets_at);
    return isFinite(r) && now < r;
  }

  function dayKey(d, tz) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  }

  /**
   * "today at 9:30 PM" / "tomorrow at 9:30 PM" / "Monday at 9:30 PM" ("Monday 9:30 PM" with short).
   * opts: { now, locale, timeZone, short }
   */
  function formatReset(iso, opts) {
    opts = opts || {};
    var t = Date.parse(iso);
    if (!isFinite(t)) return "";
    var d = new Date(t);
    var now = new Date(opts.now || Date.now());
    var tz = opts.timeZone || undefined;
    var time = new Intl.DateTimeFormat(opts.locale || "en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(d);
    var day;
    var today = dayKey(now, tz);
    var tomorrow = dayKey(new Date(now.getTime() + DAY), tz);
    var target = dayKey(d, tz);
    if (target === today) day = "today";
    else if (target === tomorrow) day = "tomorrow";
    else if (t - now.getTime() < 6.5 * DAY) day = new Intl.DateTimeFormat(opts.locale || "en-US", { weekday: "long", timeZone: tz }).format(d);
    else day = new Intl.DateTimeFormat(opts.locale || "en-US", { weekday: "long", month: "short", day: "numeric", timeZone: tz }).format(d);
    return day + (opts.short ? " " : " at ") + time;
  }

  function isDeviceScope(status) {
    return !!(status && status.scope === "device");
  }

  /** One short sentence for the popup headline. */
  function headline(status, opts) {
    if (!status) return "Checking…";
    switch (status.state) {
      case "blocked":
        return isDeviceScope(status) ? "Cap used up" : "Budget used up";
      case "over":
        return "Over budget";
      case "warn":
        return "Getting close";
      default:
        return "Within budget";
    }
  }

  /** The supporting line under the headline. */
  function detailLine(status, opts) {
    if (!status) return "";
    var when = formatReset(status.resets_at, opts);
    var resets = when ? "It resets " + when + "." : "";
    switch (status.state) {
      case "blocked":
        return isDeviceScope(status)
          ? ("This browser has used its weekly cap. " + resets + " You can change the cap in the clare dashboard.").replace("  ", " ")
          : (resets + " You can change the budget in the clare dashboard.").trim();
      case "over":
        return ("Monitor only, so nothing is blocked. " + resets).trim();
      default:
        return resets;
    }
  }

  /** One line for the collapsed banner: "Budget used up · resets Monday 9:30 PM". */
  function shortLine(status, opts) {
    if (!status) return "";
    var when = formatReset(status.resets_at, Object.assign({}, opts, { short: true }));
    return headline(status, opts) + (when && status.state === "blocked" ? " · resets " + when : "");
  }

  /** What the ring's number is a percentage of. */
  function ringCaption(status) {
    return isDeviceScope(status) ? "of this browser's weekly cap" : "of weekly budget used";
  }

  /** Where the numbers come from, in plain words. */
  function basisLine(status) {
    if (!status) return "";
    return status.basis === "estimate"
      ? "Estimated. Claude's usage meter hasn't been read this week yet."
      : "From Claude's official usage meter.";
  }

  /** Banner copy on claude.ai: prefer the server's sentence (it already uses local time). */
  function bannerText(status, opts) {
    if (!status) return "";
    if (typeof status.message === "string" && status.message) return status.message;
    var when = formatReset(status.resets_at, opts);
    var resets = when ? " It resets " + when + "." : "";
    var device = isDeviceScope(status);
    switch (status.state) {
      case "blocked":
        return device
          ? "This browser has used all of its weekly budget." + resets + " You can change it in the clare dashboard."
          : "You've used all of this week's Claude budget." + resets + " You can change the budget in the clare dashboard.";
      case "over":
        return "You're over this week's Claude budget (monitor only, nothing is blocked)." + resets;
      case "warn":
        return "Heads up: you've used " + pctLabel(status.pct) + (device ? " of this browser's weekly budget." : " of this week's Claude budget.") + resets;
      default:
        return "";
    }
  }

  /**
   * Key for a "your budget changed state" notification, or null when there's nothing to say.
   * One key per state per week, so each fires at most once a week.
   */
  function statusNotice(status) {
    if (!status || !status.resets_at) return null;
    if (status.state !== "warn" && status.state !== "blocked" && status.state !== "over") return null;
    return status.state + "|" + status.resets_at;
  }

  function pctLabel(p) {
    p = Number(p) || 0;
    if (p > 0 && p < 1) return "<1%";
    return Math.round(Math.min(p, 999)) + "%";
  }

  // ── Small parsers ────────────────────────────────────────────────────────

  var CODE_RE = /^[A-Za-z0-9_-]{4,64}$/;

  /** Enroll link or bare code → code, or null. Accepts …/enroll.html#CODE, #code=CODE, #c=CODE, ?code=CODE. */
  function parseEnrollCode(text) {
    var s = String(text || "").trim();
    if (!s) return null;
    var hash = s.indexOf("#");
    var candidate = hash === -1 ? s : s.slice(hash + 1);
    if (hash === -1 && /^https?:\/\//i.test(s)) {
      var q = /[?&](?:code|c)=([^&#]+)/.exec(s);
      candidate = q ? decodeURIComponent(q[1]) : "";
    }
    candidate = candidate.replace(/^(?:code|c)=/, "").split("&")[0].trim();
    return CODE_RE.test(candidate) ? candidate : null;
  }

  /** "Chrome on Mac", "Edge on Windows", … */
  function browserLabel(uaData, ua) {
    ua = String(ua || "");
    var brands = (uaData && uaData.brands) || [];
    var names = brands
      .map(function (b) {
        return b && b.brand;
      })
      .join("|");
    var browser = "Chrome";
    if (/Edge|Edg\//.test(names + ua)) browser = "Edge";
    else if (/Brave/.test(names)) browser = "Brave";
    else if (/Opera|OPR\//.test(names + ua)) browser = "Opera";
    var platform = (uaData && uaData.platform) || "";
    var os =
      /mac/i.test(platform) || /Macintosh|Mac OS X/.test(ua)
        ? "Mac"
        : /win/i.test(platform) || /Windows/.test(ua)
          ? "Windows"
          : /cros|chrome os/i.test(platform) || /CrOS/.test(ua)
            ? "Chromebook"
            : /linux/i.test(platform) || /Linux/.test(ua)
              ? "Linux"
              : "";
    return { browser: browser, os: os, label: os ? browser + " on " + os : browser };
  }

  var api = {
    estimateEvent: estimateEvent,
    sanitizeEvent: sanitizeEvent,
    queueAdd: queueAdd,
    parseMeter: parseMeter,
    cleanReading: cleanReading,
    isBlocking: isBlocking,
    formatReset: formatReset,
    headline: headline,
    detailLine: detailLine,
    shortLine: shortLine,
    ringCaption: ringCaption,
    basisLine: basisLine,
    bannerText: bannerText,
    statusNotice: statusNotice,
    pctLabel: pctLabel,
    parseEnrollCode: parseEnrollCode,
    browserLabel: browserLabel,
    SYSTEM_TOKENS: SYSTEM_TOKENS,
  };

  root.ClareCore = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
