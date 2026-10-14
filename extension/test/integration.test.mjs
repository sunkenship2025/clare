// End-to-end: runs the real service worker (sw.js) in Node with a fake `chrome` against a
// running clare API with an EMPTY database. Skipped unless CLARE_TEST_API is set.
//
//   CLARE_TEST_API=http://localhost:8787 node --test extension/test/integration.test.mjs
//   (optional: CLARE_TEST_SETUP_SECRET, default "dev-secret")
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const API = process.env.CLARE_TEST_API;
const SECRET = process.env.CLARE_TEST_SETUP_SECRET || "dev-secret";
const WEB = "http://localhost:8794";
const EXT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function call(path, { method = "GET", body, token } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

function fakeChrome() {
  const store = {};
  const L = { msg: [], installed: [], startup: [], alarm: [], click: [], changed: [] };
  const f = {
    store,
    alarms: {},
    notifications: [],
    tabsCreated: [],
    uninstallUrl: null,
    send(msg) {
      return new Promise((resolve) => {
        const handled = L.msg.some((fn) => fn(msg, { id: "clare-test" }, resolve) === true);
        if (!handled) resolve(undefined);
      });
    },
    fire(name, ...args) {
      return Promise.all(L[name].map((fn) => fn(...args)));
    },
  };
  const pick = (keys) => {
    if (keys == null) return structuredClone(store);
    const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const k of list) if (k in store) out[k] = structuredClone(store[k]);
    return out;
  };
  globalThis.chrome = {
    runtime: {
      id: "clare-test",
      getManifest: () => ({ version: "0.2.0" }),
      setUninstallURL: async (u) => (f.uninstallUrl = u),
      onInstalled: { addListener: (fn) => L.installed.push(fn) },
      onStartup: { addListener: (fn) => L.startup.push(fn) },
      onMessage: { addListener: (fn) => L.msg.push(fn) },
    },
    storage: {
      local: {
        get: async (keys) => pick(keys),
        set: async (obj) => Object.assign(store, structuredClone(obj)),
        remove: async (keys) => [].concat(keys).forEach((k) => delete store[k]),
      },
      onChanged: { addListener: (fn) => L.changed.push(fn) },
    },
    alarms: {
      create: (name, info) => (f.alarms[name] = info),
      get: (name, cb) => cb(f.alarms[name]),
      onAlarm: { addListener: (fn) => L.alarm.push(fn) },
    },
    notifications: {
      create: (id, opts) => f.notifications.push({ id, ...opts }),
      clear: () => {},
      onClicked: { addListener: (fn) => L.click.push(fn) },
    },
    tabs: {
      query: async () => [],
      reload: () => {},
      create: async (o) => f.tabsCreated.push(o.url),
    },
  };
  return f;
}

const settle = () => new Promise((r) => setTimeout(r, 150));

test("service worker against a live API", { skip: !API && "set CLARE_TEST_API to run" }, async () => {
  // Owner + an enroll code, done the way the dashboard would.
  const { login_code } = await call("/setup", {
    method: "POST",
    body: { secret: SECRET, owner_name: "Pranav", account_name: "My Claude", plan: "max5" },
  });
  const { token: owner } = await call("/login", { method: "POST", body: { code: login_code } });
  const { code } = await call("/enroll-code", { method: "POST", token: owner, body: {} });
  const myDevice = async () => (await call("/me", { token: owner })).devices.find((d) => d.kind === "extension" && !d.removed_at);

  // Load the real worker from a staged copy pointed at this API.
  const out = mkdtempSync(join(tmpdir(), "clare-sw-"));
  execFileSync(process.execPath, [join(EXT, "scripts/stage.mjs"), "--api", API, "--web", WEB, "--out", out]);
  const chromeFake = fakeChrome();
  const core = { exports: {} };
  new Function("module", "globalThis", readFileSync(join(EXT, "lib/core.js"), "utf8"))(core, {});
  const C = core.exports;
  const fresh = async () => {
    chromeFake.store.statusAt = 0; // stale → the next tab-hello asks the server
    return chromeFake.send({ type: "tab-hello" });
  };
  try {
    await import(pathToFileURL(join(out, "sw.js")).href);
    await chromeFake.fire("installed", { reason: "install" });
    assert.ok(chromeFake.alarms.heartbeat, "heartbeat alarm scheduled");

    // 1. Enroll from a pasted enroll link.
    let r = await chromeFake.send({ type: "enroll", code: `${WEB}/enroll.html#${code}` });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.device, "reports this browser's device name");
    assert.equal(r.state.paired, true);
    assert.equal(r.state.status.state, "ok");
    assert.match(chromeFake.uninstallUrl, new RegExp(`^${WEB}/bye\\.html#d=[^&]+&s=.+`));
    await settle();

    // 2. Enroll page opened again → already enrolled, no new device.
    r = await chromeFake.send({ type: "enroll", code });
    assert.equal(r.ok, true);
    assert.equal(r.already, true);
    let me = await call("/me", { token: owner });
    assert.equal(me.devices.filter((d) => d.kind === "extension" && !d.removed_at).length, 1);

    // 3. The official meter, in the canonical shape. clare was set up mid-week, so this
    //    first reading is the baseline (used before clare).
    await chromeFake.fire("alarm", { name: "heartbeat" });
    await settle();
    const resets = new Date(Date.now() + 3 * 86400e3).toISOString();
    r = await chromeFake.send({ type: "meter", reading: { at: new Date(Date.now() - 10_000).toISOString(), seven_day: { pct: 20, resets_at: resets }, org: "ignored" } });
    assert.equal(r.ok, true);
    assert.ok(chromeFake.store.meterAt, "meter accepted");
    me = await call("/me", { token: owner });
    assert.equal(me.account.basis, "meter");
    assert.equal(me.account.meter.seven_day.pct, 20);

    // 4. Usage from claude.ai, then the meter moves: the rise is this browser's.
    r = await chromeFake.send({
      type: "report",
      event: { key: "web:conv-1:u1", model: "claude-opus-5-5", input: 1000, output: 4000, cache_read: 20000, cache_write: 0, cache_write_1h: 0, at: new Date(Date.now() - 5_000).toISOString(), estimated: true },
    });
    assert.equal(r.ok, true);
    assert.equal(chromeFake.store.queue.length, 0, "queue flushed");
    let dev = await myDevice();
    assert.ok(dev.usage.credits > 0, "usage recorded");
    assert.equal(dev.connectivity, "online");
    r = await chromeFake.send({ type: "meter", reading: { at: new Date().toISOString(), seven_day: { pct: 25, resets_at: resets } } });
    me = await call("/me", { token: owner });
    dev = me.devices.find((d) => d.id === dev.id);
    assert.ok(Math.abs(dev.usage.points - 5) < 0.01, `the meter rise is this browser's: ${dev.usage.points}`);
    assert.ok(Math.abs(me.account.used - 25) < 0.01, `account used ${me.account.used}`);

    // 5. Budget below what's used → the browser blocks, and says so once.
    await call("/settings", { method: "PATCH", token: owner, body: { budget_pct: 10 } });
    let st = await fresh();
    assert.equal(st.status.state, "blocked");
    assert.equal(st.status.scope, "account");
    assert.equal(C.isBlocking(st.status, st.statusAt, Date.now()), true);
    assert.match(C.headline(st.status), /^Budget used up/);
    assert.equal(chromeFake.notifications.filter((n) => n.id.startsWith("status-blocked")).length, 1, "blocked notice");
    await fresh();
    assert.equal(chromeFake.notifications.filter((n) => n.id.startsWith("status-blocked")).length, 1, "only once a week");

    // 6. Monitor only → over budget, nothing blocked.
    await call("/settings", { method: "PATCH", token: owner, body: { enforce: false } });
    st = await fresh();
    assert.equal(st.status.state, "over");
    assert.equal(C.isBlocking(st.status, st.statusAt, Date.now()), false);
    await call("/settings", { method: "PATCH", token: owner, body: { enforce: true, budget_pct: 100 } });
    st = await fresh();
    assert.equal(st.status.state, "ok");

    // 7. A cap on this browser alone.
    await call(`/devices/${dev.id}`, { method: "PATCH", token: owner, body: { budget_pct: 2 } });
    st = await fresh();
    assert.equal(st.status.state, "blocked");
    assert.equal(st.status.scope, "device");
    assert.equal(st.status.device.budget, 2);
    assert.match(C.headline(st.status), /^Cap used up/);
    await call(`/devices/${dev.id}`, { method: "PATCH", token: owner, body: { budget_pct: null } });
    st = await fresh();
    assert.equal(st.status.state, "ok");

    // 8. Dashboard link from the popup.
    await chromeFake.send({ type: "open-dashboard" });
    assert.match(chromeFake.tabsCreated.at(-1), new RegExp(`^${WEB}/dash\\.html#login=.+`));

    // 9. Another device enrolls, then is uninstalled → this browser hears about it, once.
    const cli = await call("/enroll", {
      method: "POST",
      body: { code, kind: "cli", label: "Work laptop", info: { machine_id: "work-1", os: "macOS" } },
    });
    await call("/device/remove", { method: "POST", token: cli.token, body: { reason: "clare uninstall" } });
    await chromeFake.fire("alarm", { name: "heartbeat" });
    await settle();
    const messages = chromeFake.notifications.filter((n) => n.id.startsWith("alert-")).map((n) => n.message);
    console.log("notifications:", messages);
    assert.ok(messages.some((m) => /Work laptop/.test(m)), "hears about the laptop");
    const before = chromeFake.notifications.length;
    await chromeFake.fire("alarm", { name: "heartbeat" });
    await settle();
    assert.equal(chromeFake.notifications.length, before, "no repeat notifications");

    // 10. Removed from the dashboard → next heartbeat unpairs it and stops any blocking.
    await call(`/devices/${dev.id}`, { method: "DELETE", token: owner });
    await chromeFake.fire("alarm", { name: "heartbeat" });
    await settle();
    st = await chromeFake.send({ type: "get-state" });
    assert.equal(st.paired, false);
    assert.equal(st.unpairedReason, "revoked");
    assert.equal(st.status, null);
    assert.equal(chromeFake.uninstallUrl, "");

    // 11. Enroll again, then the uninstall ping (what bye.html sends).
    r = await chromeFake.send({ type: "enroll", code });
    assert.equal(r.ok, true);
    assert.notEqual(r.already, true);
    const { deviceId, byeSecret } = chromeFake.store;
    await call("/bye", { method: "POST", body: { device_id: deviceId, secret: byeSecret } });
    me = await call("/me", { token: owner });
    assert.ok(me.alerts.some((a) => a.kind === "device_removed" && a.device_id === deviceId), "the removal is an alert");

    // 12. A code that doesn't exist fails with a plain message.
    r = await chromeFake.send({ type: "enroll", code: "nosuchcode1" });
    if (!r.already) {
      assert.equal(r.ok, false);
      assert.ok(r.message);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
