// The service worker reads Claude's usage meter on its own (no claude.ai tab), with a fake
// `chrome` and a fake `fetch` standing in for claude.ai and the clare API. No network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "http://clare.test";
const ORG = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
const OTHER = "2c5f39cb-3fb2-22e3-994f-1127e4ddb538";
const HOUR = 3600e3;

const store = {};
const alarms = {};
const listeners = { msg: [], alarm: [] };
let calls = [];
let claude = {}; // path → () => Response, for claude.ai

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const html = (status) => new Response("<html>Just a moment...</html>", { status, headers: { "content-type": "text/html" } });

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  calls.push({ url, init });
  if (url.startsWith("https://claude.ai")) {
    const route = claude[new URL(url).pathname];
    return route ? route() : html(404);
  }
  if (url === API + "/meter") return json({ ok: true, stored: true });
  return json({ error: "unexpected" }, 500);
};

const pick = (keys) => {
  if (keys == null) return structuredClone(store);
  const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  const out = {};
  for (const k of list) if (k in store) out[k] = structuredClone(store[k]);
  return out;
};
const noop = { addListener: () => {} };
globalThis.chrome = {
  runtime: {
    id: "clare-test",
    getManifest: () => ({ version: "0.2.8" }),
    setUninstallURL: async () => {},
    onInstalled: noop,
    onStartup: noop,
    onMessage: { addListener: (fn) => listeners.msg.push(fn) },
  },
  storage: {
    local: {
      get: async (keys) => pick(keys),
      set: async (obj) => Object.assign(store, structuredClone(obj)),
      remove: async (keys) => [].concat(keys).forEach((k) => delete store[k]),
    },
    onChanged: noop,
  },
  alarms: {
    create: (name, info) => (alarms[name] = info),
    get: (name, cb) => cb(alarms[name]),
    onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
  },
  notifications: { create: () => {}, clear: () => {}, onClicked: noop },
  tabs: { query: async () => [], reload: () => {}, create: async () => {} },
};

const send = (msg) =>
  new Promise((resolve) => {
    if (!listeners.msg.some((fn) => fn(msg, { id: "clare-test" }, resolve) === true)) resolve(undefined);
  });
const settle = () => new Promise((r) => setTimeout(r, 30));
async function fireMeterAlarm() {
  for (const fn of listeners.alarm) fn({ name: "meter" });
  for (let i = 0; i < 10; i++) await settle();
}
const claudeCalls = () => calls.filter((c) => c.url.startsWith("https://claude.ai"));
const meterPosts = () => calls.filter((c) => c.url === API + "/meter").map((c) => JSON.parse(c.init.body));

const resets = new Date(Date.now() + 3 * 86400e3).toISOString();
const usage = () => json({ five_hour: { utilization: 14, resets_at: resets }, seven_day: { utilization: 15, resets_at: resets } });

let out;
before(async () => {
  out = mkdtempSync(join(tmpdir(), "clare-sw-meter-"));
  execFileSync(process.execPath, [join(EXT, "scripts/stage.mjs"), "--api", API, "--web", "http://web.test", "--out", out], { stdio: "ignore" });
  await import(pathToFileURL(join(out, "sw.js")).href);
});
after(() => rmSync(out, { recursive: true, force: true }));
beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  store.token = "clx_test";
  calls = [];
  claude = { "/api/organizations": () => json([{ uuid: ORG, name: "Personal", capabilities: ["chat", "claude_max"] }]) };
  claude[`/api/organizations/${ORG}/usage`] = usage;
});

test("the worker schedules a meter read every 10 minutes when it wakes", () => {
  assert.equal(alarms.meter?.periodInMinutes, 10);
  assert.ok(alarms.heartbeat, "the heartbeat alarm too");
});

test("reads the meter without a claude.ai tab and sends it to clare", async () => {
  await fireMeterAlarm();
  assert.deepEqual(
    claudeCalls().map((c) => new URL(c.url).pathname),
    ["/api/organizations", `/api/organizations/${ORG}/usage`]
  );
  for (const c of claudeCalls()) assert.equal(c.init.credentials, "include", "uses the browser's claude.ai sign-in");
  const [sent] = meterPosts();
  assert.equal(sent.seven_day.pct, 15);
  assert.equal(sent.five_hour.pct, 14);
  assert.ok(Date.parse(sent.at) <= Date.now());
  assert.equal(store.meterOrg, ORG, "remembers the org");
  assert.ok(store.meterAt, "the reading was accepted");

  // Within 10 minutes: no second read, from the background or a tab.
  calls = [];
  await fireMeterAlarm();
  assert.equal(calls.length, 0);
  assert.deepEqual(await send({ type: "meter-slot", org: ORG }), { go: false });
});

test("uses the org a claude.ai tab last read, without asking for the list", async () => {
  claude[`/api/organizations/${OTHER}/usage`] = usage;
  await send({ type: "meter", org: OTHER, reading: { at: new Date().toISOString(), seven_day: { pct: 3, resets_at: resets } } });
  assert.equal(store.meterOrg, OTHER);
  calls = [];
  store.meterLastAt = 0;
  await fireMeterAlarm();
  assert.deepEqual(claudeCalls().map((c) => new URL(c.url).pathname), [`/api/organizations/${OTHER}/usage`]);
  assert.equal(meterPosts().length, 1);
});

test("a challenge page backs the background read off for an hour, and tabs still read", async () => {
  store.meterOrg = ORG;
  claude[`/api/organizations/${ORG}/usage`] = () => html(403);
  await fireMeterAlarm();
  assert.equal(meterPosts().length, 0);
  const wait = store.meterBgUnavailableUntil - Date.now();
  assert.ok(wait > 0.9 * HOUR && wait <= HOUR, `backs off about an hour: ${wait}`);
  assert.equal(store.meterLastAt, 0, "gives the slot back");
  assert.equal(store.meterOrg, ORG, "a challenge page isn't a reason to forget the org");
  assert.equal(store.meterUnavailableUntil, undefined, "the tabs' backoff is untouched");
  assert.deepEqual(await send({ type: "meter-slot", org: ORG }), { go: true }, "a tab can read right away");

  // Still backing off: nothing is fetched.
  calls = [];
  store.meterLastAt = 0;
  await fireMeterAlarm();
  assert.equal(calls.length, 0);
});

test("the tabs' backoff doesn't stop the background read", async () => {
  store.meterUnavailableUntil = Date.now() + 6 * HOUR;
  await fireMeterAlarm();
  assert.equal(meterPosts().length, 1);
  assert.deepEqual(await send({ type: "meter-slot" }), { go: false });
});

test("claude.ai saying no to the org forgets it; signed out or offline just waits", async () => {
  store.meterOrg = ORG;
  claude[`/api/organizations/${ORG}/usage`] = () => json({ type: "error", error: { type: "permission_error" } }, 403);
  await fireMeterAlarm();
  assert.equal(store.meterOrg, undefined);
  assert.ok(store.meterBgUnavailableUntil > Date.now());

  // Signed out: the org list itself fails.
  delete store.meterBgUnavailableUntil;
  store.meterLastAt = 0;
  claude["/api/organizations"] = () => json({ type: "error", error: { type: "authentication_error" } }, 401);
  await fireMeterAlarm();
  assert.equal(meterPosts().length, 0);
  assert.ok(store.meterBgUnavailableUntil > Date.now());

  // Offline.
  delete store.meterBgUnavailableUntil;
  store.meterLastAt = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  try {
    await fireMeterAlarm();
  } finally {
    globalThis.fetch = real;
  }
  assert.ok(store.meterBgUnavailableUntil > Date.now());
  assert.equal(store.meterLastAt, 0);
});

test("several orgs and no tab to say which: waits instead of guessing", async () => {
  claude["/api/organizations"] = () =>
    json([
      { uuid: ORG, capabilities: ["chat", "claude_pro"] },
      { uuid: OTHER, capabilities: ["chat", "claude_max"] },
    ]);
  await fireMeterAlarm();
  assert.deepEqual(claudeCalls().map((c) => new URL(c.url).pathname), ["/api/organizations"]);
  assert.equal(store.meterOrg, undefined);
  assert.equal(meterPosts().length, 0);
});

test("a usage payload clare can't read isn't sent", async () => {
  claude[`/api/organizations/${ORG}/usage`] = () => json({ something: "else" });
  await fireMeterAlarm();
  assert.equal(meterPosts().length, 0);
  assert.ok(store.meterBgUnavailableUntil > Date.now());
});

test("not connected to clare: no background reads", async () => {
  delete store.token;
  await fireMeterAlarm();
  assert.equal(calls.length, 0);
});
