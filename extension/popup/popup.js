/* clare popup: this browser's budget at a glance, and enrollment when it isn't connected. */
(function () {
  "use strict";

  var C = globalThis.ClareCore;
  var $ = function (id) {
    return document.getElementById(id);
  };

  function send(msg) {
    return chrome.runtime.sendMessage(msg).catch(function () {
      return null;
    });
  }

  function show(view) {
    ["loading", "paired", "unpaired"].forEach(function (v) {
      $("view-" + v).hidden = v !== view;
    });
  }

  var TONE = { ok: "", warn: "warn", over: "bad", blocked: "bad" };

  function pctOf(n) {
    return n == null || !isFinite(Number(n)) ? "–" : C.pctLabel(Number(n));
  }

  function renderPaired(s) {
    var status = s.status;
    $("hello").textContent = s.deviceLabel || "";

    var pct = status ? Number(status.pct) || 0 : 0;
    $("pct").textContent = status ? C.pctLabel(pct) : "–";
    $("pct-sub").textContent = C.ringCaption(status);
    var arc = $("arc");
    var shown = status ? Math.max(pct > 0 ? 2 : 0, Math.min(100, pct)) : 0;
    arc.setAttribute("stroke-dasharray", shown + " " + (100 - shown));
    arc.setAttribute("class", "arc " + ((status && TONE[status.state]) || "") + (shown ? "" : " empty"));

    $("headline").textContent = status ? C.headline(status) : "Connecting…";
    $("detail").textContent = status ? C.detailLine(status) : "";
    $("offline").hidden = !s.offline;

    // Points are % of the account's weekly limit.
    var acc = (status && status.account) || null;
    var about = status && status.basis === "estimate" ? "about " : "";
    $("account-used").textContent = acc
      ? about + pctOf(acc.used) + " · budget " + pctOf(acc.budget) + (status.enforce === false ? " (monitor only)" : "")
      : "–";
    var dev = (status && status.device) || null;
    $("row-device").hidden = !dev;
    if (dev) {
      $("device-used").textContent = about + pctOf(dev.used) + (dev.budget != null ? " · cap " + pctOf(dev.budget) : "");
    }
    $("basis").textContent = C.basisLine(status);

    $("browser-dot").className = "dot " + (s.offline ? "warn" : "ok");
    $("browser-state").textContent = s.offline ? "Can't reach clare" : "Connected";

    var cli = s.cli;
    $("row-terminal").hidden = !cli;
    if (cli) {
      var computers = cli.count === 1 ? "1 computer" : cli.count + " computers";
      $("term-dot").className = "dot " + (cli.problem ? "bad" : cli.online ? "ok" : "");
      $("term-state").textContent = cli.problem
        ? "Needs a fix"
        : cli.online
          ? cli.online + " of " + computers + " online"
          : computers + ", offline";
    }
    show("paired");
  }

  function renderUnpaired(s) {
    $("hello").textContent = "";
    var why = {
      revoked: "This browser was removed from clare. To add it again, use Add a device in the clare dashboard and paste the link below.",
      unauthorized: "This browser lost its connection to clare. Paste a new enroll link from the dashboard to reconnect.",
      disconnected: "You disconnected this browser. Paste an enroll link to connect it again.",
    }[s.unpairedReason];
    if (why) $("unpaired-why").textContent = why;
    show("unpaired");
  }

  function render(s) {
    if (!s) return;
    if (s.paired) renderPaired(s);
    else renderUnpaired(s);
  }

  $("pair-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var err = $("pair-error");
    var code = C.parseEnrollCode($("link").value);
    if (!code) {
      err.textContent = "That doesn't look like a clare enroll link. Copy the whole link and try again.";
      return;
    }
    err.textContent = "";
    var btn = $("connect");
    btn.disabled = true;
    btn.textContent = "Connecting…";
    send({ type: "enroll", code: code }).then(function (r) {
      btn.disabled = false;
      btn.textContent = "Connect";
      if (r && r.ok) {
        $("link").value = "";
        render(r.state);
        send({ type: "refresh" }).then(render);
      } else {
        err.textContent = (r && r.message) || "Couldn't connect. Check your internet and try again.";
      }
    });
  });

  $("open-dash").addEventListener("click", function () {
    send({ type: "open-dashboard" }).then(function () {
      window.close();
    });
  });

  send({ type: "get-state" }).then(function (s) {
    render(s);
    if (s && s.paired) send({ type: "refresh" }).then(render);
  });
})();
