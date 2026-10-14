/*
 * clare page helpers — what runs inside claude.ai's own page (MAIN world): URL matchers,
 * an SSE parser and size counting. Plain script: attaches `ClarePage` to the global object
 * (inject.js removes it again), and to module.exports under Node.
 *
 * Kept separate from lib/core.js on purpose: Chrome injects a given file only once per
 * frame, so the MAIN-world and isolated-world scripts can't both list the same file.
 */
(function (root) {
  "use strict";

  // ── claude.ai URL matchers ────────────────────────────────────────────────

  var UUIDISH = "[0-9a-fA-F]{8}-[0-9a-fA-F-]{20,}";
  var COMPLETION_RE = new RegExp(
    "^/api/organizations/(" + UUIDISH + ")/chat_conversations/(" + UUIDISH + ")/(completion|retry_completion)/?$"
  );
  var CONVERSATION_RE = new RegExp(
    "^/api/organizations/(" + UUIDISH + ")/chat_conversations/(" + UUIDISH + ")/?$"
  );
  var ORG_RE = new RegExp("^/api/organizations/(" + UUIDISH + ")(?:/|$)");

  function pathnameOf(url) {
    try {
      return new URL(String(url), "https://claude.ai").pathname;
    } catch (e) {
      return "";
    }
  }

  /** POST …/chat_conversations/<conv>/(completion|retry_completion) → { org, conv, kind } */
  function matchCompletion(url, method) {
    if (String(method || "GET").toUpperCase() !== "POST") return null;
    var m = COMPLETION_RE.exec(pathnameOf(url));
    return m ? { org: m[1], conv: m[2], kind: m[3] } : null;
  }

  /** GET …/chat_conversations/<conv>?… (a conversation load) → { org, conv } */
  function matchConversation(url, method) {
    if (String(method || "GET").toUpperCase() !== "GET") return null;
    var m = CONVERSATION_RE.exec(pathnameOf(url));
    return m ? { org: m[1], conv: m[2] } : null;
  }

  /** Any /api/organizations/<org>/… URL → org id */
  function matchOrg(url) {
    var m = ORG_RE.exec(pathnameOf(url));
    return m ? m[1] : null;
  }

  // ── Server-sent events ───────────────────────────────────────────────────

  /**
   * Incremental SSE parser. push() text chunks in any split; onEvent receives
   * { event, data, raw } where data is parsed JSON when possible, else the raw string.
   */
  function createSseParser(onEvent) {
    var buf = "";
    var dataLines = [];
    var eventName = null;

    function dispatch() {
      if (!dataLines.length) {
        eventName = null;
        return;
      }
      var raw = dataLines.join("\n");
      var name = eventName;
      dataLines = [];
      eventName = null;
      var data = raw;
      try {
        data = JSON.parse(raw);
      } catch (e) {}
      try {
        onEvent({ event: name, data: data, raw: raw });
      } catch (e) {}
    }

    function line(l) {
      if (l === "") return dispatch();
      if (l.charAt(0) === ":") return; // comment / keep-alive
      var i = l.indexOf(":");
      var field = i === -1 ? l : l.slice(0, i);
      var value = i === -1 ? "" : l.slice(i + 1);
      if (value.charAt(0) === " ") value = value.slice(1);
      if (field === "data") dataLines.push(value);
      else if (field === "event") eventName = value;
    }

    function drain(final) {
      for (;;) {
        var n = buf.indexOf("\n");
        var r = buf.indexOf("\r");
        if (n === -1 && r === -1) break;
        var idx = n === -1 ? r : r === -1 ? n : Math.min(n, r);
        var len = 1;
        if (buf.charAt(idx) === "\r") {
          // A chunk may end between \r and \n — wait for more input.
          if (idx === buf.length - 1 && !final) break;
          if (buf.charAt(idx + 1) === "\n") len = 2;
        }
        var l = buf.slice(0, idx);
        buf = buf.slice(idx + len);
        line(l);
      }
    }

    return {
      push: function (text) {
        buf += String(text || "");
        drain(false);
      },
      end: function () {
        drain(true);
        if (buf) {
          line(buf);
          buf = "";
        }
        dispatch();
      },
    };
  }

  function bigger(a, b) {
    return typeof b === "number" && isFinite(b) && b > (a || 0) ? b : a || 0;
  }

  /**
   * Accumulates what we need from a completion stream. Tolerates both the
   * Messages-API event shapes and older `{type:"completion", completion:"…"}` events;
   * unknown events are ignored.
   */
  function createCompletionAccumulator() {
    var r = { model: null, outputChars: 0, messageUuid: null, limits: [], usage: null, events: 0, error: null };

    function addStr(s) {
      if (typeof s === "string") r.outputChars += s.length;
    }
    function setModel(m) {
      if (typeof m === "string" && m) r.model = m;
    }
    function mergeUsage(u) {
      if (!u || typeof u !== "object") return;
      var cur = r.usage || {};
      r.usage = {
        input_tokens: bigger(cur.input_tokens, u.input_tokens),
        output_tokens: bigger(cur.output_tokens, u.output_tokens),
        cache_read_input_tokens: bigger(cur.cache_read_input_tokens, u.cache_read_input_tokens),
        cache_creation_input_tokens: bigger(cur.cache_creation_input_tokens, u.cache_creation_input_tokens),
        has_input: !!(cur.has_input || typeof u.input_tokens === "number"),
        has_output: !!(cur.has_output || typeof u.output_tokens === "number"),
      };
    }

    function onEvent(ev) {
      var d = ev && ev.data;
      if (!d || typeof d !== "object" || Array.isArray(d)) return;
      r.events++;
      var t = d.type || (ev && ev.event) || "";

      setModel(d.model);
      if (d.message && typeof d.message === "object") {
        setModel(d.message.model);
        var id = d.message.uuid || d.message.id;
        if (typeof id === "string" && id && !r.messageUuid) r.messageUuid = id;
        mergeUsage(d.message.usage);
      }
      mergeUsage(d.usage);

      if (t === "content_block_start" && d.content_block) {
        addStr(d.content_block.text);
        addStr(d.content_block.thinking);
      } else if (t === "content_block_delta" && d.delta) {
        addStr(d.delta.text);
        addStr(d.delta.thinking);
        addStr(d.delta.partial_json);
      } else if (t === "completion") {
        addStr(d.completion);
      } else if (t === "error") {
        r.error = d.error || d;
      }

      if (d.message_limit && typeof d.message_limit === "object") r.limits.push(d.message_limit);
      if (d.messageLimit && typeof d.messageLimit === "object") r.limits.push(d.messageLimit);
    }

    return {
      onEvent: onEvent,
      result: function () {
        return r;
      },
    };
  }

  // ── Size counting ────────────────────────────────────────────────────────

  var TEXT_KEYS = { text: 1, thinking: 1, extracted_content: 1, completion: 1, prompt: 1 };

  function sumText(node, depth, budget) {
    if (budget.n <= 0 || depth > 14 || node === null || typeof node !== "object") return 0;
    budget.n--;
    var total = 0;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) total += sumText(node[i], depth + 1, budget);
      return total;
    }
    // Messages carry both a flat `text` and structured `content`; count the content once.
    var hasContent = Array.isArray(node.content);
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      var v = node[k];
      if (typeof v === "string") {
        if (TEXT_KEYS[k] && !(k === "text" && hasContent)) total += v.length;
      } else if (k === "input" && v && typeof v === "object") {
        try {
          total += JSON.stringify(v).length;
        } catch (e) {}
      } else if (v && typeof v === "object") {
        total += sumText(v, depth + 1, budget);
      }
    }
    return total;
  }

  /**
   * Total text length of a loaded conversation. When the payload is a message tree
   * (`current_leaf_message_uuid` + `parent_message_uuid`), only the active branch counts.
   */
  function countConversationChars(json) {
    if (!json || typeof json !== "object") return 0;
    var budget = { n: 200000 };
    var msgs = Array.isArray(json.chat_messages) ? json.chat_messages : null;
    if (!msgs) return sumText(json, 0, budget);
    var leaf = json.current_leaf_message_uuid;
    var byId = Object.create(null);
    for (var i = 0; i < msgs.length; i++) if (msgs[i] && msgs[i].uuid) byId[msgs[i].uuid] = msgs[i];
    if (leaf && byId[leaf]) {
      var total = 0;
      var seen = Object.create(null);
      var cur = byId[leaf];
      while (cur && !seen[cur.uuid]) {
        seen[cur.uuid] = 1;
        total += sumText(cur, 0, budget);
        cur = byId[cur.parent_message_uuid];
      }
      return total;
    }
    return sumText(msgs, 0, budget);
  }

  /** Characters the person is sending in a completion request body. */
  function promptCharsFromBody(body) {
    if (!body || typeof body !== "object") return 0;
    var n = typeof body.prompt === "string" ? body.prompt.length : 0;
    if (Array.isArray(body.attachments)) {
      for (var i = 0; i < body.attachments.length; i++) {
        var a = body.attachments[i];
        if (a && typeof a.extracted_content === "string") n += a.extracted_content.length;
      }
    }
    return n;
  }

  var api = {
    matchCompletion: matchCompletion,
    matchConversation: matchConversation,
    matchOrg: matchOrg,
    createSseParser: createSseParser,
    createCompletionAccumulator: createCompletionAccumulator,
    countConversationChars: countConversationChars,
    promptCharsFromBody: promptCharsFromBody,
  };

  root.ClarePage = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
