/*
 * clare service worker: enrollment, status cache, usage queue, heartbeat, meter readings,
 * notifications. All state lives in chrome.storage.local (the worker can be stopped at any time).
 */
import "./config.js";
import "./lib/core.js";

const CFG = globalThis.CLARE_CONFIG;
const C = globalThis.ClareCore;

const HEARTBEAT_MINUTES = 5;
const STATUS_STALE_MS = 60 * 1000;
const METER_EVERY_MS = 10 * 60 * 1000;
const METER_BACKOFF_MS = 6 * 60 * 60 * 1000;
const MAX_BATCH = 500;

// ── storage ───────────────────────────────────────────────────────────────

const load = () => chrome.storage.local.get(null);
const save = (patch) => chrome.storage.local.set(patch);

async function installId() {
  const { installId } = await chrome.storage.local.get("installId");
  if (installId) return installId;
  const id = crypto.randomUUID();
  await save({ installId: id });
  return id;
}

function timeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

async function deviceInfo() {
  const b = C.browserLabel(navigator.userAgentData, navigator.userAgent);
  return {
    label: b.label,
    info: {
      machine_id: await installId(),
      browser: b.browser,
      os: b.os,
      version: chrome.runtime.getManifest().version,
      tz: timeZone(),
    },
  };
}

// ── API ───────────────────────────────────────────────────────────────────

async function api(path, { method = "GET", body, token } = {}) {
  const headers = { "X-Clare-TZ": timeZone() };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  let res;
  try {
    res = await fetch(CFG.apiUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, network: true, status: 0, data: null };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { ok: res.ok, status: res.status, data };
}

/**
 * Authenticated call. 410 = this browser was removed from clare; 401 = the server doesn't know
 * this token (e.g. a reset database). Either way forget the token, which also stops any blocking.
 */
async function authed(path, opts = {}) {
  const st = await load();
  if (!st.token) return { ok: false, unpaired: true, status: 0, data: null };
  const r = await api(path, { ...opts, token: st.token });
  if (r.status === 401 || r.status === 410) {
    await unpair(r.status === 410 ? "revoked" : "unauthorized");
  } else if (r.network) {
    await save({ offline: true });
  } else if (r.ok) {
    await save({ offline: false, lastContactAt: Date.now() });
  }
  return r;
}

async function setStatus(status) {
  if (!status || typeof status !== "object") return;
  const patch = { status, statusAt: Date.now() };
  if (status.device && status.device.label) patch.deviceLabel = status.device.label;
  await save(patch);
  await noticeStatus(status);
}

/** Tell the person once a week per state when this browser gets close to, or reaches, its budget. */
async function noticeStatus(status) {
  const key = C.statusNotice(status);
  if (!key) return;
  const { noticed = [] } = await chrome.storage.local.get("noticed");
  if (noticed.includes(key)) return;
  await save({ noticed: noticed.concat(key).slice(-12) });
  const title = { warn: "Getting close to your Claude budget", blocked: "Claude budget used up", over: "Over your Claude budget" }[status.state];
  try {
    chrome.notifications.create("status-" + key, {
      type: "basic",
      iconUrl: "icons/128.png",
      title: title || "clare",
      message: C.bannerText(status) || status.title || "Your Claude budget changed.",
      priority: status.state === "warn" ? 0 : 1,
    });
  } catch {}
}

// ── enrollment ────────────────────────────────────────────────────────────

async function setUninstallUrl() {
  const st = await load();
  const url =
    st.token && st.deviceId && st.byeSecret
      ? `${CFG.webUrl}/bye.html#d=${encodeURIComponent(st.deviceId)}&s=${encodeURIComponent(st.byeSecret)}`
      : "";
  try {
    await chrome.runtime.setUninstallURL(url);
  } catch {}
}

async function unpair(reason) {
  await chrome.storage.local.remove(["token", "deviceId", "byeSecret", "api", "status", "statusAt", "queue", "cli"]);
  await save({ unpairedReason: reason || null, offline: false });
  await setUninstallUrl();
}

/**
 * Enroll this browser with a code from the dashboard's "Add a device".
 * Already enrolled with this clare server and the token still works → nothing to do,
 * whatever the code (every code belongs to the same account).
 */
async function enroll(code) {
  if (!code) return { ok: false, error: "bad_code", message: "That doesn't look like a clare enroll link or code." };
  let st = await load();

  if (st.token && st.api === CFG.apiUrl) {
    const r = await authed("/check", { method: "POST", body: {} });
    if (r.ok || r.network) {
      if (r.ok) await setStatus(r.data && r.data.status);
      st = await load();
      return { ok: true, already: true, device: st.deviceLabel || null };
    }
    st = await load(); // token was rejected — enroll again below
  }

  const { label, info } = await deviceInfo();
  const r = await api("/enroll", { method: "POST", body: { code, kind: "extension", label, info } });
  if (!r.ok) {
    return {
      ok: false,
      error: (r.data && r.data.error) || (r.network ? "network" : "failed"),
      message:
        (r.data && r.data.message) ||
        (r.network
          ? "Couldn't reach clare. Check your internet and try again."
          : "That enroll link didn't work. Make a new one in the clare dashboard (Add a device)."),
    };
  }

  const status = (r.data && r.data.status) || null;
  const deviceLabel = (status && status.device && status.device.label) || label;
  await save({
    token: r.data.token,
    deviceId: r.data.device_id,
    byeSecret: r.data.bye_secret,
    api: CFG.apiUrl,
    deviceLabel,
    enrolledAt: Date.now(),
    unpairedReason: null,
    offline: false,
    queue: [],
  });
  await setStatus(status);
  await setUninstallUrl();
  ensureAlarms();
  heartbeat();
  return { ok: true, device: deviceLabel };
}

// ── usage queue ───────────────────────────────────────────────────────────

let flushing = null;

async function enqueue(events) {
  const clean = (events || []).map(C.sanitizeEvent).filter(Boolean);
  if (!clean.length) return;
  const { queue } = await chrome.storage.local.get("queue");
  await save({ queue: C.queueAdd(queue || [], clean, 1000) });
}

function flush() {
  if (!flushing) flushing = doFlush().finally(() => (flushing = null));
  return flushing;
}

async function doFlush() {
  const st = await load();
  if (!st.token) return;
  const batch = (st.queue || []).slice(0, MAX_BATCH);
  if (!batch.length) return;
  const r = await authed("/report", { method: "POST", body: { events: batch } });
  if (r.ok || (r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 410 && r.status !== 429)) {
    // Sent (or rejected as malformed — don't retry poison forever).
    const sent = new Set(batch.map((e) => e.key));
    const { queue } = await chrome.storage.local.get("queue");
    await save({ queue: (queue || []).filter((e) => !sent.has(e.key)) });
    if (r.ok) await setStatus(r.data && r.data.status);
    const left = await chrome.storage.local.get("queue");
    if ((left.queue || []).length) return doFlush();
  } else if (!r.unpaired && r.status !== 401 && r.status !== 410) {
    chrome.alarms.create("flush", { delayInMinutes: 1 });
  }
}

// ── status, heartbeat, meter ──────────────────────────────────────────────

async function refreshStatus() {
  const r = await authed("/check", { method: "POST", body: {} });
  if (r.ok) await setStatus(r.data && r.data.status);
  return r.ok;
}

/** Claude Code on the owner's computers, for the popup's connection card. */
async function refreshMe() {
  const r = await authed("/me");
  if (!r.ok || !r.data) return null;
  const cli = (r.data.devices || []).filter((d) => d.kind === "cli" && !d.removed_at);
  const summary = cli.length
    ? {
        count: cli.length,
        online: cli.filter((d) => d.connectivity === "online").length,
        problem: cli.filter((d) => d.connectivity === "problem").length,
      }
    : null;
  await save({ cli: summary });
  if (r.data.status) await setStatus(r.data.status);
  return summary;
}

async function heartbeat() {
  const st = await load();
  if (!st.token) return;
  const { info } = await deviceInfo();
  const r = await authed("/heartbeat", { method: "POST", body: { info, health: { ok: true, problems: [] } } });
  if (r.ok && r.data) {
    await setStatus(r.data.status);
    await notifyAlerts(r.data.alerts || []);
  }
  await flush();
}

async function notifyAlerts(alerts) {
  if (!alerts.length) return;
  const st = await load();
  const seen = new Set(st.seenAlertIds || []);
  for (const a of alerts) {
    if (!a || seen.has(a.id)) continue;
    seen.add(a.id);
    try {
      chrome.notifications.create("alert-" + a.id, {
        type: "basic",
        iconUrl: "icons/128.png",
        title: "clare",
        message: a.message || "Something changed on one of your devices.",
        priority: a.kind === "device_enrolled" ? 0 : 1,
      });
    } catch {}
  }
  await save({ seenAlertIds: Array.from(seen).slice(-200) });
}

/** One meter read per 10 min across all tabs; back off for 6h after a failure. */
async function meterSlot() {
  const { meterLastAt = 0, meterUnavailableUntil = 0, token } = await chrome.storage.local.get([
    "meterLastAt",
    "meterUnavailableUntil",
    "token",
  ]);
  const now = Date.now();
  if (!token || now < meterUnavailableUntil || now - meterLastAt < METER_EVERY_MS) return false;
  await save({ meterLastAt: now });
  return true;
}

async function sendMeter(raw) {
  const reading = C.cleanReading(raw, Date.now());
  if (!reading) return;
  const r = await authed("/meter", { method: "POST", body: reading });
  if (r.ok) await save({ meter: reading, meterAt: Date.now() });
}

async function openDashboard() {
  const r = await authed("/login-link", { method: "POST", body: {} });
  const url = r.ok && r.data && r.data.code ? `${CFG.webUrl}/dash.html#login=${encodeURIComponent(r.data.code)}` : `${CFG.webUrl}/dash.html`;
  await chrome.tabs.create({ url });
  return { ok: r.ok };
}

async function publicState() {
  const st = await load();
  return {
    paired: !!st.token,
    deviceLabel: st.deviceLabel || null,
    status: st.status || null,
    statusAt: st.statusAt || 0,
    offline: !!st.offline,
    cli: st.cli || null,
    unpairedReason: st.unpairedReason || null,
    webUrl: CFG.webUrl,
  };
}

// ── wiring ────────────────────────────────────────────────────────────────

function ensureAlarms() {
  chrome.alarms.get("heartbeat", (a) => {
    if (!a) chrome.alarms.create("heartbeat", { periodInMinutes: HEARTBEAT_MINUTES, delayInMinutes: 0.5 });
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  ensureAlarms();
  await installId();
  await setUninstallUrl();
  if (details.reason === "install") {
    // Installed from the enroll page's "Add to Chrome" step: the open enroll tab
    // predates this install, so reload it to let enroll.js connect automatically.
    try {
      const tabs = await chrome.tabs.query({ url: CFG.webUrl + "/enroll.html*" });
      for (const t of tabs) chrome.tabs.reload(t.id);
    } catch {}
  }
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarms();
  heartbeat();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "heartbeat") heartbeat();
  else if (alarm.name === "flush") flush();
});

chrome.notifications.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
  openDashboard();
});

const handlers = {
  async "get-state"() {
    return publicState();
  },
  async refresh() {
    const st = await load();
    if (st.token) {
      await refreshMe();
      await flush();
    }
    return publicState();
  },
  async "tab-hello"() {
    const st = await load();
    if (st.token && Date.now() - (st.statusAt || 0) > STATUS_STALE_MS) await refreshStatus();
    if (st.token && (st.queue || []).length) flush();
    return publicState();
  },
  async enroll(msg) {
    const code = C.parseEnrollCode(msg.code);
    const r = await enroll(code);
    return { ...r, state: await publicState() };
  },
  async report(msg) {
    const { token } = await chrome.storage.local.get("token");
    if (!token) return { ok: false, unpaired: true }; // not enrolled: nowhere to count it
    await enqueue([msg.event]);
    await flush();
    return { ok: true };
  },
  async meter(msg) {
    await sendMeter(msg.reading);
    return { ok: true };
  },
  async "meter-slot"() {
    return { go: await meterSlot() };
  },
  async "meter-failed"() {
    await save({ meterUnavailableUntil: Date.now() + METER_BACKOFF_MS });
    return { ok: true };
  },
  async "open-dashboard"() {
    return openDashboard();
  },
  async disconnect() {
    const st = await load();
    if (st.token) {
      await api("/device/remove", { method: "POST", token: st.token, body: { reason: "Disconnected from the clare popup." } });
    }
    await unpair("disconnected");
    return publicState();
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || !handlers[msg.type]) return false;
  handlers[msg.type](msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: "internal", message: String((err && err.message) || err) }));
  return true; // async response
});
