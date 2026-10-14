/*
 * clare — runs in claude.ai's page (MAIN world) at document_start.
 * Wraps window.fetch to *observe* completions and conversation loads, and to refuse
 * new completions while the weekly budget is used up. Any failure in here must
 * fall through to the untouched native fetch — never break the page.
 * Only sizes and ids leave this script; message text never does.
 */
(function () {
  "use strict";

  var C = window.ClarePage;
  try {
    delete window.ClarePage; // lib/page.js ran in this world just for us; don't leave it on the page
  } catch (e) {}
  if (!C) return;

  var TAG = "__clare_v1__";
  var nativeFetch = window.fetch;
  if (typeof nativeFetch !== "function" || nativeFetch.__clare) return;

  var blocked = false;
  var knownOrg = null;

  function post(type, payload) {
    try {
      var msg = { dir: "to-isolated", type: type, payload: payload };
      msg[TAG] = true;
      window.postMessage(msg, location.origin);
    } catch (e) {}
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (e.source !== window || !d || d[TAG] !== true || d.dir !== "to-main") return;
    if (d.type === "status") blocked = !!(d.payload && d.payload.blocked);
  });

  function requestInfo(input, init) {
    var url = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
    if (!url) return null;
    var method = (init && init.method) || (input && typeof input === "object" && input.method) || "GET";

    var org = C.matchOrg(url);
    if (org && org !== knownOrg) {
      knownOrg = org;
      post("org", { org: org });
    }

    var comp = C.matchCompletion(url, method);
    if (comp) {
      var body = null;
      if (init && typeof init.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch (e) {}
      }
      var turn = (body && body.turn_message_uuids) || {};
      return {
        kind: "completion",
        org: comp.org,
        conv: comp.conv,
        model: body && typeof body.model === "string" ? body.model : null,
        promptChars: C.promptCharsFromBody(body),
        assistantUuid: typeof turn.assistant_message_uuid === "string" ? turn.assistant_message_uuid : null,
        at: Date.now(),
      };
    }

    var conv = C.matchConversation(url, method);
    if (conv) return { kind: "conversation", org: conv.org, conv: conv.conv };
    return null;
  }

  function blockedResponse() {
    return new Response(
      JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "This week's Claude budget (set in clare) is used up." },
      }),
      { status: 429, headers: { "content-type": "application/json" } }
    );
  }

  function observeCompletion(res, info) {
    if (!res || !res.ok || !res.body) return;
    var reader = res.clone().body.getReader();
    var decoder = new TextDecoder();
    var acc = C.createCompletionAccumulator();
    var parser = C.createSseParser(acc.onEvent);
    var done = false;

    function finish() {
      if (done) return;
      done = true;
      try {
        parser.end();
      } catch (e) {}
      var r = acc.result();
      if (!r.events && !r.outputChars) return;
      post("completion", {
        org: info.org,
        conv: info.conv,
        model: r.model || info.model,
        promptChars: info.promptChars,
        outputChars: r.outputChars,
        messageUuid: r.messageUuid || info.assistantUuid,
        usage: r.usage,
        limits: r.limits.slice(0, 5),
        at: info.at,
      });
    }

    function pump() {
      return reader.read().then(function (chunk) {
        if (chunk.done) return finish();
        parser.push(decoder.decode(chunk.value, { stream: true }));
        return pump();
      });
    }

    // A stopped generation errors the stream — still count what was produced.
    pump().catch(finish);
  }

  function observeConversation(res, info) {
    if (!res || !res.ok) return;
    var type = (res.headers && res.headers.get("content-type")) || "";
    if (type.indexOf("json") === -1) return;
    res
      .clone()
      .json()
      .then(function (json) {
        post("conversation", { conv: info.conv, chars: C.countConversationChars(json) });
      })
      .catch(function () {});
  }

  function clareFetch(input, init) {
    var info = null;
    try {
      info = requestInfo(input, init);
    } catch (e) {
      info = null;
    }
    if (!info) return nativeFetch.apply(window, arguments);

    if (info.kind === "completion" && blocked) {
      post("blocked-attempt", {});
      return Promise.resolve(blockedResponse());
    }

    var p = nativeFetch.apply(window, arguments);
    p.then(
      function (res) {
        try {
          if (info.kind === "completion") observeCompletion(res, info);
          else observeConversation(res, info);
        } catch (e) {}
      },
      function () {}
    );
    return p;
  }

  clareFetch.__clare = true;
  try {
    window.fetch = clareFetch;
  } catch (e) {}
})();
