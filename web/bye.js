// bye.html#d=<device_id>&s=<secret> — opened by Chrome when the extension is uninstalled.
// Tells the server (so the dashboard marks this browser as removed), then shows a calm message either way.

import { api } from "./api.js";
import { $, icon, markSvg } from "./ui.js";

$("#wordmark").innerHTML = `${markSvg(26)}<span>clare</span>`;
$("#bye-icon").innerHTML = icon("unplug", 26);

const params = new URLSearchParams(location.hash.replace(/^#/, ""));
const deviceId = params.get("d");
const secret = params.get("s");
// Don't leave the secret sitting in the address bar or history.
history.replaceState(null, "", location.pathname + location.search);

if (deviceId && secret) {
  api("/bye", { method: "POST", body: { device_id: deviceId, secret }, auth: false }).catch(() => {
    // Nothing to do here; the dashboard will show the browser as offline instead.
  });
}
