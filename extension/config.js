/*
 * Deployment config. scripts/build.mjs (or extension/tools/stage.mjs) replaces the
 * placeholders. Unreplaced placeholders fall back to the local dev servers.
 */
(function (root) {
  "use strict";
  var API = "__CLARE_API_URL__";
  var WEB = "__CLARE_WEB_URL__";

  function pick(value, dev) {
    return value.indexOf("__CLARE_") === 0 ? dev : value.replace(/\/+$/, "");
  }

  root.CLARE_CONFIG = {
    apiUrl: pick(API, "http://localhost:8787"),
    webUrl: pick(WEB, "http://localhost:8788"),
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
