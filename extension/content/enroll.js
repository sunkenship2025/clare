/*
 * clare — runs on the enroll page (webUrl/enroll.html). Enrolls this browser automatically
 * with the code the page puts in <main data-enroll-code>, and reports back through attributes
 * on that same element (content-script objects aren't visible to page scripts):
 *
 *   data-extension-installed="1"                     the extension is present
 *   data-extension-state="connecting|connected|error"
 *   data-extension-device="Chrome on Mac"            (connected) this browser's device name
 *   data-extension-error="…"                         (error) a friendly message
 *
 * Each change also dispatches a bubbling `clare:extension-<state>` event (`clare:extension-installed`
 * first). A browser that is already enrolled reports `connected` straight away.
 */
(function () {
  "use strict";

  var busy = false;
  var current = null;

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(function () {
        return null;
      });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function set(el, attrs, eventName) {
    Object.keys(attrs).forEach(function (k) {
      if (attrs[k] === null) el.removeAttribute(k);
      else el.setAttribute(k, attrs[k]);
    });
    el.dispatchEvent(new CustomEvent(eventName, { bubbles: true }));
  }

  function handle(el, r) {
    if (r && r.ok) {
      set(
        el,
        {
          "data-extension-state": "connected",
          "data-extension-device": (r.device || (r.state && r.state.deviceLabel) || "").toString(),
          "data-extension-error": null,
        },
        "clare:extension-connected"
      );
    } else {
      set(
        el,
        {
          "data-extension-state": "error",
          "data-extension-error": (r && r.message) || "Couldn't connect this browser. Try reloading this page.",
        },
        "clare:extension-error"
      );
    }
  }

  function connect(el) {
    var code = (el.getAttribute("data-enroll-code") || "").trim();
    if (!code || busy || code === current) return;
    busy = true;
    current = code;
    set(el, { "data-extension-state": "connecting" }, "clare:extension-connecting");
    send({ type: "enroll", code: code }).then(function (r) {
      busy = false;
      handle(el, r);
    });
  }

  function attach(el) {
    set(el, { "data-extension-installed": "1" }, "clare:extension-installed");
    // The page may fill the code in after loading.
    new MutationObserver(function () {
      connect(el);
    }).observe(el, { attributes: true, attributeFilter: ["data-enroll-code"] });
    connect(el);
  }

  var el = document.querySelector("[data-enroll-code]");
  if (el) return attach(el);
  var obs = new MutationObserver(function () {
    var found = document.querySelector("[data-enroll-code]");
    if (found) {
      obs.disconnect();
      attach(found);
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(function () {
    obs.disconnect();
  }, 60000);
})();
