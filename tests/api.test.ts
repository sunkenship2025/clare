// End-to-end API tests against a real Postgres (scripts/dev-db.sh start).
// Uses a fresh `clare_test` database and a controllable clock.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { createApp } from "../supabase/functions/_shared/app.ts";

const ROOT = resolve(import.meta.dirname, "..");
// Server base URL; CI sets e.g. postgres://postgres:postgres@localhost:5432
const PG = process.env.CLARE_TEST_PG ?? "postgres://localhost:54329";
const ADMIN_URL = `${PG}/postgres`;
const TEST_URL = `${PG}/clare_test`;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let sql: postgres.Sql;
let now = new Date("2026-10-14T12:00:00Z"); // Wednesday; clare is set up mid-week
let handle: (req: Request) => Promise<Response>;

const TZ = "Asia/Kolkata";
const RESET = "2026-10-19T16:00:00.000Z"; // the official weekly reset: Monday 9:30 PM IST

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "x-clare-tz": TZ };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await handle(new Request(`http://local/functions/v1/api${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }));
  const data = await res.json();
  return { status: res.status, data };
}

const later = (ms: number) => (now = new Date(now.getTime() + ms));

before(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe("drop database if exists clare_test with (force)");
  await admin.unsafe("create database clare_test");
  await admin.end();
  sql = postgres(TEST_URL, { onnotice: () => {} });
  const dir = join(ROOT, "supabase", "migrations");
  for (const f of readdirSync(dir).sort()) await sql.unsafe(readFileSync(join(dir, f), "utf8"));
  handle = createApp({ sql, setupSecret: "s3cret", now: () => now });
});

after(async () => {
  await sql?.end();
});

// Shared state across the story-style tests below (they run in order).
const s: Record<string, string> = {};

/** An Opus reply worth `credits` (output tokens at $20/M), one minute ago. */
const opus = (key: string, credits: number) => ({
  key,
  model: "claude-opus-5-5",
  output: credits * 50_000,
  at: new Date(now.getTime() - MIN).toISOString(),
});

const meter = (pct: number, extra: Record<string, unknown> = {}) => ({
  at: now.toISOString(),
  seven_day: { pct, resets_at: RESET },
  five_hour: { pct: pct / 2, resets_at: new Date(now.getTime() + 3 * HOUR).toISOString() },
  ...extra,
});

type Dev = { id: string; label: string; kind: string; connectivity: string; enforcement: string; budget_pct: number | null; usage: { points: number; credits: number } };
const dev = (me: { devices: Dev[] }, label: string) => me.devices.find((d) => d.label === label)!;

test("health reports needs_setup, then setup and one-time login", async () => {
  let r = await call("GET", "/health");
  assert.equal(r.data.needs_setup, true);
  assert.equal(r.data.version, "0.2.6");

  r = await call("POST", "/check", { token: "clr_x" });
  assert.equal(r.status, 503, "nothing works before setup");

  r = await call("POST", "/setup", { body: { secret: "wrong", owner_name: "Pranav" } });
  assert.equal(r.status, 403);

  r = await call("POST", "/setup", { body: { secret: "s3cret", owner_name: "Pranav", account_name: "Pranav's Claude", plan: "max5" } });
  assert.equal(r.status, 200);
  const code = r.data.login_code;

  r = await call("POST", "/setup", { body: { secret: "s3cret", owner_name: "Eve" } });
  assert.equal(r.status, 409, "second setup must fail");

  r = await call("POST", "/login", { body: { code } });
  assert.equal(r.status, 200);
  s.web = r.data.token;
  assert.match(s.web, /^clr_/);
  assert.equal(r.data.admin, true, "the setup link signs in as admin");

  r = await call("POST", "/login", { body: { code } });
  assert.equal(r.status, 401, "login codes are single use");

  r = await call("GET", "/health");
  assert.equal(r.data.needs_setup, false);
});

test("the dashboard mints an enroll code; the enroll page can look it up", async () => {
  let r = await call("POST", "/enroll-code", { token: s.web });
  assert.equal(r.status, 200);
  s.code = r.data.code;
  assert.equal(new Date(r.data.expires_at).getTime(), now.getTime() + 7 * DAY);

  r = await call("GET", `/enroll/${s.code}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { account_name: "Pranav's Claude", owner_name: "Pranav", admin: false, kind: null, expired: false, devices: [] });

  r = await call("GET", "/enroll/nopenopenope");
  assert.equal(r.status, 404);
  assert.equal(r.data.error, "invalid_code");
});

test("enroll two computers and a browser; re-enrolling a machine replaces it", async () => {
  let r = await call("POST", "/enroll", { body: { code: s.code, kind: "cli", label: "MacBook Air", info: { os: "macOS", machine_id: "m1" } } });
  assert.equal(r.status, 200);
  s.mac = r.data.token;
  s.macId = r.data.device_id;
  assert.equal(r.data.status.state, "ok");
  assert.equal(r.data.status.basis, "estimate");
  assert.equal(r.data.status.device.label, "MacBook Air");

  later(MIN);
  r = await call("POST", "/enroll", { body: { code: s.code.toUpperCase(), kind: "extension", label: "Chrome on MacBook Air", info: { os: "macOS", browser: "Chrome" } } });
  s.ext = r.data.token;
  s.extId = r.data.device_id;
  s.extBye = r.data.bye_secret;

  later(MIN);
  r = await call("POST", "/enroll", { body: { code: s.code, kind: "cli", label: "ThinkPad", info: { os: "Linux", machine_id: "t1" } } });
  s.pc = r.data.token;
  s.pcId = r.data.device_id;

  r = await call("POST", "/enroll", { body: { code: s.code, kind: "phone" } });
  assert.equal(r.status, 400);

  r = await call("GET", `/enroll/${s.code}`);
  assert.deepEqual(r.data.devices.map((d: { kind: string; label: string }) => [d.kind, d.label]),
    [["cli", "MacBook Air"], ["extension", "Chrome on MacBook Air"], ["cli", "ThinkPad"]]);

  r = await call("GET", "/me", { token: s.web });
  assert.deepEqual(r.data.alerts.map((a: { message: string }) => a.message).sort(), [
    "Claude Code on MacBook Air is now connected.",
    "Claude Code on ThinkPad is now connected.",
    "The browser extension in Chrome on MacBook Air is now connected.",
  ]);
});

test("before any meter reading, usage is an estimate from the plan's capacity", async () => {
  const r = await call("POST", "/report", { token: s.pc, body: { events: [opus("pc:0", 3), opus("pc:0", 3)] } });
  assert.equal(r.status, 200);
  assert.equal(r.data.accepted, 1, "duplicate keys in one batch count once");
  assert.equal(r.data.status.basis, "estimate");
  assert.equal(r.data.status.used, 1, "3 credits × 100 / 300");
  assert.equal(r.data.status.title, "~1% used");
  assert.equal(r.data.status.message, "You've used about 1% of this week's Claude budget.");

  const again = await call("POST", "/report", { token: s.pc, body: { events: [opus("pc:0", 3)] } });
  assert.equal(again.data.accepted, 1);
  assert.equal(again.data.status.used, 1, "re-reporting a key never double counts");
});

test("the official meter decides how much; activity decides which device", async () => {
  // First reading: clare was set up mid-week, so the 20% already used is before clare.
  later(HOUR);
  let r = await call("POST", "/report", { token: s.mac, body: { events: [], meter: meter(20) } });
  assert.equal(r.data.status.basis, "meter");
  assert.equal(r.data.status.resets_at, RESET, "the week follows the official reset");
  assert.equal(r.data.status.used, 20);

  // The Mac does 20 credits of work, then the meter shows 24%.
  later(HOUR);
  r = await call("POST", "/report", { token: s.mac, body: { events: [opus("mac:1", 20)], meter: meter(24) } });
  assert.equal(r.data.status.used, 24);
  assert.equal(r.data.status.device.used, 4);

  // claude.ai in Chrome does 10 credits, the meter (read by the extension, claude.ai's shape) says 26%.
  later(HOUR);
  await call("POST", "/report", { token: s.ext, body: { events: [{ ...opus("web:1", 10), estimated: true }] } });
  r = await call("POST", "/meter", { token: s.ext, body: { seven_day: { utilization: 26, resets_at: RESET } } });
  assert.deepEqual(r.data, { ok: true, stored: true });
  r = await call("POST", "/meter", { token: s.ext, body: { seven_day: { utilization: 26, resets_at: RESET } } });
  assert.equal(r.data.stored, false, "the same step isn't stored twice");

  // The meter rises 3 more points with nothing on any clare device: unobserved (a phone, say).
  later(HOUR);
  r = await call("POST", "/meter", { token: s.pc, body: meter(29) });
  assert.equal(r.data.stored, true);

  r = await call("GET", "/me", { token: s.web });
  const a = r.data.account;
  assert.equal(a.basis, "meter");
  assert.equal(a.used, 29);
  assert.equal(a.before_clare, 20);
  assert.equal(a.observed, 6);
  assert.equal(a.unobserved, 3);
  assert.equal(a.pending, 0, "the ThinkPad's 3 credits came before the baseline reading, so they're in before_clare");
  assert.equal(a.meter.seven_day.pct, 29);
  assert.equal(a.meter.five_hour.pct, 14.5);
  assert.equal(a.meter.device_label, "ThinkPad");
  assert.equal(a.week.resets_at, RESET);
  assert.deepEqual(a.capacity, { value: 500, source: "calibrated" }, "30 credits made 6 points → 500 credits/week");
  assert.equal(dev(r.data, "MacBook Air").usage.points, 4);
  assert.equal(dev(r.data, "Chrome on MacBook Air").usage.points, 2);
  assert.equal(dev(r.data, "ThinkPad").usage.points, 0);
  assert.equal(dev(r.data, "ThinkPad").usage.credits, 3);
  assert.equal(dev(r.data, "MacBook Air").usage.credits, 20);
  assert.ok(r.data.alerts.some((x: { kind: string; message: string }) =>
    x.kind === "unobserved_usage" && x.message.startsWith("About 3% of this week's limit was used where clare couldn't see it")));
  assert.equal(r.data.status.device, null, "dashboards have no device");
  assert.equal(r.data.daily.length, 3);
});

test("stale and junk readings are rejected", async () => {
  let r = await call("POST", "/meter", { token: s.mac, body: { seven_day: { pct: 50, resets_at: "2026-10-12T16:00:00Z" } } });
  assert.deepEqual(r.data, { ok: true, stored: false }, "a reading from a week that already reset");
  r = await call("POST", "/meter", { token: s.mac, body: { seven_day: "lots" } });
  assert.equal(r.status, 400);
  r = await call("POST", "/meter", { token: s.web, body: meter(40) });
  assert.equal(r.status, 403, "dashboards can't report");
  r = await call("POST", "/report", { token: s.web, body: { events: [opus("web:x", 1)] } });
  assert.equal(r.status, 403);
});

test("the weekly budget warns, blocks, and can be monitor-only", async () => {
  let r = await call("PATCH", "/settings", { token: s.web, body: { budget_pct: 33 } });
  assert.equal(r.status, 200);
  r = await call("POST", "/check", { token: s.mac });
  assert.equal(r.data.status.state, "warn");
  assert.equal(r.data.status.limit, 33);
  assert.equal(r.data.status.message, "Heads up: you've used 87% of this week's Claude budget. It resets on Monday at 9:30 PM.");

  // 25 more credits on the Mac after the last reading, at this week's 0.2 points/credit → 5 pending points → 34 of 33.
  later(10 * MIN);
  r = await call("POST", "/report", { token: s.mac, body: { events: [opus("mac:2", 15), opus("mac:3", 10)] } });
  assert.equal(r.data.status.state, "blocked");
  assert.equal(r.data.status.allowed, false);
  assert.equal(r.data.status.scope, "account");
  assert.equal(r.data.status.title, "Budget used up");
  assert.equal(r.data.status.message,
    "You've used all of this week's Claude budget. It resets on Monday at 9:30 PM. You can change the budget in the clare dashboard.");

  r = await call("POST", "/check", { token: s.ext });
  assert.equal(r.data.status.state, "blocked", "the budget is account-wide");

  await call("PATCH", "/settings", { token: s.web, body: { enforce: false } });
  r = await call("POST", "/check", { token: s.ext });
  assert.equal(r.data.status.state, "over");
  assert.equal(r.data.status.allowed, true);
  assert.equal(r.data.status.enforce, false);

  await call("PATCH", "/settings", { token: s.web, body: { enforce: true, budget_pct: 100 } });
  r = await call("POST", "/check", { token: s.ext });
  assert.equal(r.data.status.state, "ok");
});

test("a per-device cap binds only that device", async () => {
  let r = await call("PATCH", `/devices/${s.macId}`, { token: s.web, body: { budget_pct: 5 } });
  assert.equal(r.status, 200);
  r = await call("POST", "/check", { token: s.mac });
  assert.equal(r.data.status.state, "blocked");
  assert.equal(r.data.status.scope, "device");
  assert.equal(r.data.status.limit, 5);
  assert.match(r.data.status.message, /^MacBook Air has used all of its weekly budget\./);
  r = await call("POST", "/check", { token: s.ext });
  assert.equal(r.data.status.state, "ok");

  r = await call("PATCH", `/devices/${s.macId}`, { token: s.web, body: { budget_pct: 0 } });
  assert.equal(r.status, 400);
  r = await call("PATCH", `/devices/${s.macId}`, { token: s.web, body: { label: "  " } });
  assert.equal(r.status, 400);
  r = await call("PATCH", `/devices/${s.macId}`, { token: s.web, body: { label: "Work Mac" } });
  assert.equal(r.status, 200);
  r = await call("GET", "/me", { token: s.web });
  assert.equal(dev(r.data, "Work Mac").budget_pct, 5);
});

test("re-enrolling the same machine keeps its history and cap; the old token is revoked", async () => {
  let r = await call("POST", "/enroll", { body: { code: s.code, kind: "cli", label: "Work Mac", info: { os: "macOS", machine_id: "m1" } } });
  assert.equal(r.status, 200);
  const fresh = r.data.token;
  assert.equal(r.data.status.device.budget, 5);

  r = await call("POST", "/check", { token: s.mac });
  assert.equal(r.status, 410);
  assert.equal(r.data.error, "revoked");
  s.mac = fresh;
  s.macId = (await call("POST", "/check", { token: fresh })).data.status.device.id;

  r = await call("GET", "/me", { token: s.web });
  assert.equal(r.data.devices.filter((d: Dev) => d.kind === "cli").length, 2, "the replaced device is hidden");
  assert.equal(dev(r.data, "Work Mac").usage.credits, 45, "usage moved over");
  assert.equal(r.data.alerts.filter((a: { kind: string }) => a.kind === "device_enrolled").length, 3, "no new enrolled alert");
});

test("heartbeats report config changes once and deliver alerts about other devices", async () => {
  let r = await call("POST", "/heartbeat", { token: s.ext, body: { info: { version: "0.2.0" } } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.settings, { enforce: true, strict_hooks: false });
  assert.ok(r.data.alerts.some((a: { kind: string }) => a.kind === "unobserved_usage"));
  assert.ok(!r.data.alerts.some((a: { message: string }) => a.message.includes("Chrome on MacBook Air")), "not about itself");
  r = await call("POST", "/heartbeat", { token: s.ext, body: {} });
  assert.equal(r.data.alerts.length, 0, "each alert is delivered once");

  r = await call("POST", "/heartbeat", { token: s.pc, body: { health: { ok: false, problems: ["hook settings missing"] } } });
  await call("POST", "/heartbeat", { token: s.pc, body: { health: { ok: false, problems: ["hook settings missing"] } } });
  r = await call("POST", "/heartbeat", { token: s.ext, body: {} });
  assert.deepEqual(r.data.alerts.map((a: { kind: string; message: string }) => [a.kind, a.message]), [
    ["config_changed", "clare's files on ThinkPad were changed (hook settings missing). It restored what it could."],
  ]);

  r = await call("GET", "/me", { token: s.web });
  assert.equal(dev(r.data, "ThinkPad").connectivity, "problem");
  assert.equal(dev(r.data, "ThinkPad").enforcement, "unverified");
  await call("POST", "/heartbeat", { token: s.pc, body: { health: { ok: true } } });
  r = await call("GET", "/me", { token: s.web });
  assert.equal(dev(r.data, "ThinkPad").enforcement, "active");
});

test("a device that goes quiet for 2 days raises an alert that clears when it's back", async () => {
  later(49 * HOUR);
  let r = await call("GET", "/me", { token: s.web });
  const offline = r.data.alerts.filter((a: { kind: string }) => a.kind === "device_offline");
  assert.equal(offline.length, 3);
  assert.ok(offline.some((a: { message: string }) =>
    a.message === "ThinkPad hasn't checked in for 2 days, so clare can't confirm its budget holds."));
  assert.ok(r.data.devices.every((d: Dev) => d.enforcement === "unverified"));

  r = await call("GET", "/me", { token: s.web });
  assert.equal(r.data.alerts.filter((a: { kind: string }) => a.kind === "device_offline").length, 3, "raised once");

  await call("POST", "/heartbeat", { token: s.pc, body: {} });
  r = await call("GET", "/me", { token: s.web });
  assert.equal(r.data.alerts.filter((a: { kind: string }) => a.kind === "device_offline").length, 2);
  assert.equal(dev(r.data, "ThinkPad").enforcement, "active");
});

test("uninstalls and dashboard removal revoke devices", async () => {
  let r = await call("POST", "/bye", { body: { device_id: s.extId, secret: "bye_wrong" } });
  assert.equal(r.status, 403);
  r = await call("POST", "/bye", { body: { device_id: s.extId, secret: s.extBye } });
  assert.equal(r.status, 200);
  r = await call("POST", "/bye", { body: { device_id: s.extId, secret: s.extBye } });
  assert.equal(r.status, 200, "idempotent");
  r = await call("POST", "/check", { token: s.ext });
  assert.equal(r.status, 410);

  r = await call("POST", "/device/remove", { token: s.pc, body: { reason: "uninstalled" } });
  assert.equal(r.status, 200);

  r = await call("DELETE", `/devices/${s.macId}`, { token: s.web });
  assert.equal(r.status, 200);
  r = await call("POST", "/check", { token: s.mac });
  assert.equal(r.status, 410);

  r = await call("GET", "/me", { token: s.web });
  const removed = r.data.alerts.filter((a: { kind: string }) => a.kind === "device_removed").map((a: { message: string }) => a.message);
  assert.deepEqual(removed.sort(), [
    "The clare extension was removed from Chrome on MacBook Air.",
    "clare was removed from ThinkPad (Claude Code).",
  ]);
  assert.ok(r.data.devices.every((d: Dev) => d.enforcement === "removed"));
  assert.equal(r.data.alerts.filter((a: { kind: string }) => a.kind === "device_offline").length, 0, "removing a device clears its offline alert");

  r = await call("POST", `/alerts/${r.data.alerts[0].id}/resolve`, { token: s.web });
  assert.equal(r.status, 200);
  r = await call("POST", "/alerts/999999/resolve", { token: s.web });
  assert.equal(r.status, 404);
});

test("after the reset with no new reading, usage starts over as an estimate", async () => {
  now = new Date("2026-10-20T06:00:00Z");
  let r = await call("POST", "/enroll-code", { token: s.web });
  r = await call("POST", "/enroll", { body: { code: r.data.code, kind: "cli", label: "Mac mini", info: { machine_id: "mm" } } });
  const mini = r.data.token;
  r = await call("POST", "/report", { token: mini, body: { events: [opus("mini:1", 5)] } });
  assert.equal(r.data.status.basis, "estimate");
  assert.equal(r.data.status.resets_at, "2026-10-26T16:00:00.000Z", "aligned to the last official reset");
  assert.equal(r.data.status.used, 1, "5 credits × 100 / calibrated 500");

  r = await call("GET", "/me", { token: s.web });
  assert.equal(r.data.account.meter, null, "last week's reading isn't shown as this week's");
});

test("enroll links expire after 7 days", async () => {
  let r = await call("POST", "/enroll-code", { token: s.web });
  const code = r.data.code;
  later(7 * DAY + MIN);
  r = await call("GET", `/enroll/${code}`);
  assert.equal(r.data.expired, true);
  r = await call("POST", "/enroll", { body: { code, kind: "cli", label: "Late" } });
  assert.equal(r.status, 410);
  assert.equal(r.data.error, "expired_code");
});

test("settings are validated; a lost dashboard link can be recovered", async () => {
  let r = await call("PATCH", "/settings", { token: s.web, body: { capacity_manual: -3 } });
  assert.equal(r.status, 400);
  r = await call("PATCH", "/settings", { token: s.web, body: { budget_pct: 120 } });
  assert.equal(r.status, 400);
  r = await call("PATCH", "/settings", { token: s.web, body: { warn_pct: 5 } });
  assert.equal(r.status, 400);
  r = await call("PATCH", "/settings", { token: s.web, body: { plan: "team" } });
  assert.equal(r.status, 400);
  r = await call("PATCH", "/settings", {
    token: s.web,
    body: { capacity_manual: 800, plan: "max20", warn_pct: 70, strict_hooks: true, owner_name: "P", account_name: "Mine" },
  });
  assert.equal(r.status, 200);
  r = await call("GET", "/me", { token: s.web });
  assert.deepEqual(r.data.account.capacity, { value: 800, source: "manual" });
  assert.equal(r.data.account.plan, "max20");
  assert.equal(r.data.account.warn_pct, 70);
  assert.equal(r.data.account.strict_hooks, true);
  assert.equal(r.data.account.name, "Mine");

  r = await call("POST", "/recover", { body: { secret: "nope" } });
  assert.equal(r.status, 403);
  r = await call("POST", "/recover", { body: { secret: "s3cret" } });
  r = await call("POST", "/login", { body: { code: r.data.login_code } });
  assert.equal(r.status, 200);
  r = await call("GET", "/me", { token: r.data.token });
  assert.equal(r.status, 200);
});

test("only admin devices, and dashboards opened from them, can change things", async () => {
  let r = await call("POST", "/enroll-code", { token: s.web, body: { admin: true } });
  assert.equal(r.data.admin, true);
  const adminCode = r.data.code;
  assert.equal((await call("GET", `/enroll/${adminCode}`)).data.admin, true);
  r = await call("POST", "/enroll", { body: { code: adminCode, kind: "cli", label: "Admin Mac", info: { machine_id: "am" } } });
  const adminMac = r.data.token;

  r = await call("POST", "/enroll-code", { token: s.web, body: {} });
  r = await call("POST", "/enroll", { body: { code: r.data.code, kind: "cli", label: "Build server", info: { machine_id: "bs" } } });
  const server = r.data.token;
  const serverId = r.data.device_id;

  // A regular device does its job but can't change anything.
  assert.equal((await call("POST", "/check", { token: server })).status, 200);
  for (const [method, path, body] of [
    ["PATCH", "/settings", { budget_pct: 100, enforce: false }],
    ["POST", "/enroll-code", { admin: true }],
    ["PATCH", `/devices/${serverId}`, { budget_pct: null, admin: true }],
    ["DELETE", `/devices/${serverId}`, undefined],
    ["POST", "/alerts/1/resolve", {}],
  ] as const) {
    r = await call(method, path, { token: server, body });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.data.error, "admin_only");
  }

  // Its dashboard is view-only too.
  r = await call("POST", "/login-link", { token: server });
  r = await call("POST", "/login", { body: { code: r.data.code } });
  assert.equal(r.data.admin, false);
  const serverWeb = r.data.token;
  r = await call("GET", "/me", { token: serverWeb });
  assert.equal(r.status, 200);
  assert.equal(r.data.me.admin, false);
  assert.equal(r.data.devices.find((d: { label: string }) => d.label === "Admin Mac").admin, true);
  assert.equal((await call("PATCH", "/settings", { token: serverWeb, body: { budget_pct: 50 } })).status, 403);

  // An admin device's dashboard can change things, including making another device admin.
  r = await call("POST", "/login-link", { token: adminMac });
  r = await call("POST", "/login", { body: { code: r.data.code } });
  assert.equal(r.data.admin, true);
  r = await call("PATCH", `/devices/${serverId}`, { token: r.data.token, body: { admin: true } });
  assert.equal(r.status, 200);
  assert.equal((await call("PATCH", "/settings", { token: server, body: { warn_pct: 75 } })).status, 200);

  // Any device can add a browser: a one-hour, browser-only code with the asking device's rights.
  later(MIN);
  r = await call("POST", "/enroll-code", { token: s.web, body: {} });
  r = await call("POST", "/enroll", { body: { code: r.data.code, kind: "cli", label: "Mac mini 2", info: { machine_id: "mm2" } } });
  const regular = r.data.token;
  r = await call("POST", "/enroll-code", { token: regular, body: { kind: "extension", admin: true } });
  assert.equal(r.status, 200, "a regular device can add a browser");
  assert.equal(r.data.admin, false, "but can't hand out admin");
  assert.equal(r.data.kind, "extension");
  assert.equal(new Date(r.data.expires_at).getTime(), now.getTime() + HOUR);
  const browserCode = r.data.code;
  r = await call("POST", "/enroll", { body: { code: browserCode, kind: "cli", label: "Sneaky" } });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, "wrong_kind");
  r = await call("POST", "/enroll", { body: { code: browserCode, kind: "extension", label: "Chrome on Mac mini" } });
  assert.equal(r.status, 200);
  r = await call("POST", "/enroll-code", { token: server, body: { kind: "extension", admin: true } });
  assert.equal(r.data.admin, true, "an admin device's browsers can be admin");

  // Re-enrolling the same machine with a regular link keeps it admin.
  r = await call("POST", "/enroll-code", { token: adminMac, body: {} });
  r = await call("POST", "/enroll", { body: { code: r.data.code, kind: "cli", label: "Build server", info: { machine_id: "bs" } } });
  assert.equal((await call("PATCH", "/settings", { token: r.data.token, body: { warn_pct: 80 } })).status, 200);
});

test("bad tokens, unknown routes, CORS", async () => {
  assert.equal((await call("POST", "/check", { token: "clr_nope" })).status, 401);
  assert.equal((await call("POST", "/check")).status, 401);
  assert.equal((await call("GET", "/nope", { token: s.web })).status, 404);
  assert.equal((await call("POST", "/share", { token: s.web, body: {} })).status, 404, "sharing is gone");
  const pre = await handle(new Request("http://local/api/check", { method: "OPTIONS" }));
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
});

test("a browser added from a computer belongs to it: one cap, one card, removed together", async () => {
  const me = async () => (await call("GET", "/me", { token: s.web })).data;
  let r = await call("POST", "/enroll-code", { token: s.web, body: { admin: true } });
  r = await call("POST", "/enroll", { body: { code: r.data.code, kind: "cli", label: "Studio", info: { os: "macOS", machine_id: "studio-1" } } });
  const studio = r.data.token;
  const studioId = r.data.device_id;

  // `clare browser` on that computer mints a browser code that carries it.
  r = await call("POST", "/enroll-code", { token: studio, body: { kind: "extension", admin: true } });
  r = await call("POST", "/enroll", { body: { code: r.data.code, kind: "extension", label: "Chrome on Mac", info: { machine_id: "studio-chrome" } } });
  assert.equal(r.status, 200);
  const chrome = r.data.token;
  const chromeId = r.data.device_id;
  assert.equal(r.data.status.device.id, studioId, "the browser is judged as its computer");
  assert.equal(r.data.status.device.label, "Studio");
  assert.equal((await me()).devices.find((d: { id: string }) => d.id === chromeId).parent_id, studioId);

  // The computer's cap covers the browser.
  r = await call("PATCH", `/devices/${studioId}`, { token: s.web, body: { budget_pct: 7 } });
  assert.equal(r.status, 200);
  r = await call("POST", "/check", { token: chrome });
  assert.equal(r.data.status.device.budget, 7);

  // Unlinked on the dashboard, the browser stands alone; linked again, it's back.
  r = await call("PATCH", `/devices/${chromeId}`, { token: s.web, body: { parent_id: null } });
  r = await call("POST", "/check", { token: chrome });
  assert.equal(r.data.status.device.id, chromeId);
  r = await call("PATCH", `/devices/${studioId}`, { token: s.web, body: { parent_id: chromeId } });
  assert.equal(r.status, 400, "only browsers can belong to a computer");
  r = await call("PATCH", `/devices/${chromeId}`, { token: s.web, body: { parent_id: studioId } });
  assert.equal(r.status, 200);

  // Re-enrolling the browser (same install) keeps its computer.
  r = await call("POST", "/enroll-code", { token: s.web, body: { kind: "extension" } });
  r = await call("POST", "/enroll", { body: { code: r.data.code, kind: "extension", label: "Chrome on Mac", info: { machine_id: "studio-chrome" } } });
  const chrome2 = r.data.token;
  assert.equal(r.data.status.device.id, studioId);

  // Reinstalling clare on the computer: its browsers follow the new device.
  r = await call("POST", "/enroll-code", { token: s.web, body: { admin: true } });
  r = await call("POST", "/enroll", { body: { code: r.data.code, kind: "cli", label: "Studio", info: { machine_id: "studio-1" } } });
  const studio2Id = r.data.device_id;
  r = await call("POST", "/check", { token: chrome2 });
  assert.equal(r.data.status.device.id, studio2Id);
  assert.equal(r.data.status.device.budget, 7, "the cap carries over");

  // Removing the computer on the dashboard removes its browsers too.
  r = await call("DELETE", `/devices/${studio2Id}`, { token: s.web });
  assert.equal(r.status, 200);
  r = await call("POST", "/check", { token: chrome2 });
  assert.equal(r.status, 410);
});

test("single-source meter rises are learned and reported on /me", async () => {
  const [row] = await sql`select source_rates from clare_settings where id = 1`;
  const learned = row.source_rates as { cli?: { points: number }; web?: { points: number } };
  assert.ok((learned?.cli?.points ?? 0) + (learned?.web?.points ?? 0) > 0, JSON.stringify(learned));
  const r = await call("GET", "/me", { token: s.web });
  assert.equal(typeof r.data.account.estimation.browser_weight, "number");
  assert.equal(r.data.account.estimation.min_points, 3);
});

test("groups: a group's computers share part of the weekly limit", async () => {
  const me = async () => (await call("GET", "/me", { token: s.web })).data;
  type Member = { id: string; group_id: string | null; usage: { points: number } };
  const find = (m: { devices: Member[] }, id: string) => m.devices.find((d) => d.id === id)!;

  // A computer with a browser on it.
  let r = await call("POST", "/enroll-code", { token: s.web, body: { admin: true } });
  r = await call("POST", "/enroll", { body: { code: r.data.code, kind: "cli", label: "Air", info: { machine_id: "air-1" } } });
  const air = r.data.token;
  const airId = r.data.device_id;
  r = await call("POST", "/enroll-code", { token: air, body: { kind: "extension" } });
  r = await call("POST", "/enroll", { body: { code: r.data.code, kind: "extension", label: "Chrome on Air", info: { machine_id: "air-chrome" } } });
  const chrome = r.data.token;
  const chromeId = r.data.device_id;

  // A group needs a name and a share; a browser on a computer can't join on its own.
  r = await call("POST", "/groups", { token: s.web, body: { label: " ", budget_pct: 50 } });
  assert.equal(r.status, 400);
  r = await call("POST", "/groups", { token: s.web, body: { label: "pranav", budget_pct: 0 } });
  assert.equal(r.status, 400);
  r = await call("POST", "/groups", { token: s.web, body: { label: "pranav", budget_pct: 50, device_ids: [chromeId] } });
  assert.equal(r.status, 400);
  assert.equal((await me()).groups.length, 0, "a rejected group isn't half made");
  r = await call("POST", "/groups", { token: s.web, body: { label: "pranav", budget_pct: 50, device_ids: [airId] } });
  assert.equal(r.status, 200);
  const pranav = r.data.id;

  // An "Add a device" link can put the new computer straight into a group.
  later(MIN);
  r = await call("POST", "/groups", { token: s.web, body: { label: "joy", budget_pct: 50 } });
  const joy = r.data.id;
  r = await call("POST", "/enroll-code", { token: s.web, body: { group_id: joy } });
  assert.equal(r.data.group_id, joy);
  r = await call("POST", "/enroll", { body: { code: r.data.code, kind: "cli", label: "joy's Claude Code", info: { os: "Windows", machine_id: "joy-1" } } });
  const joyPc = r.data.token;
  const joyPcId = r.data.device_id;
  assert.deepEqual(r.data.status.group, { id: joy, label: "joy", used: 0, budget: 50, pct: 0 });
  r = await call("POST", "/enroll-code", { token: s.web, body: { group_id: "00000000-0000-0000-0000-000000000000" } });
  assert.equal(r.status, 400);

  // The browser is judged with its computer's group, and both count toward it.
  later(MIN);
  await call("POST", "/report", { token: air, body: { events: [opus("air:1", 16)] } });
  r = await call("POST", "/report", { token: chrome, body: { events: [{ ...opus("airweb:1", 8), estimated: true }] } });
  const g = r.data.status.group;
  let m = await me();
  assert.equal(g.id, pranav);
  assert.ok(g.used > 1, String(g.used));
  assert.ok(Math.abs(g.used - (find(m, airId).usage.points + find(m, chromeId).usage.points)) < 0.01);
  assert.deepEqual(m.groups.map((x: { label: string; budget_pct: number }) => [x.label, x.budget_pct]), [["pranav", 50], ["joy", 50]]);
  assert.equal(find(m, airId).group_id, pranav);
  assert.equal(find(m, chromeId).group_id, null, "browsers follow their computer");

  // A share smaller than what's used stops that group's computers, not the other group's.
  r = await call("PATCH", `/groups/${pranav}`, { token: s.web, body: { budget_pct: 1 } });
  assert.equal(r.status, 200);
  r = await call("POST", "/check", { token: chrome });
  assert.equal(r.data.status.scope, "group");
  assert.equal(r.data.status.state, "blocked");
  assert.equal(r.data.status.title, "Share used up");
  assert.match(r.data.status.message, /^The pranav group has used all of its weekly share\./);
  r = await call("POST", "/check", { token: joyPc });
  assert.equal(r.data.status.state, "ok");

  // Moving a computer into a group, out of it, and into one that's gone.
  r = await call("PATCH", `/devices/${joyPcId}`, { token: s.web, body: { group_id: pranav } });
  assert.equal(r.status, 200);
  r = await call("POST", "/check", { token: joyPc });
  assert.equal(r.data.status.group.id, pranav);
  assert.equal(r.data.status.state, "blocked");
  await call("PATCH", `/devices/${joyPcId}`, { token: s.web, body: { group_id: null } });
  r = await call("POST", "/check", { token: joyPc });
  assert.equal(r.data.status.group, null);
  r = await call("PATCH", `/devices/${joyPcId}`, { token: s.web, body: { group_id: "00000000-0000-0000-0000-000000000000" } });
  assert.equal(r.status, 400);

  // A group's member list says exactly who's in it.
  await call("PATCH", `/groups/${joy}`, { token: s.web, body: { label: "Joy", device_ids: [joyPcId] } });
  assert.equal(find(await me(), joyPcId).group_id, joy);
  await call("PATCH", `/groups/${joy}`, { token: s.web, body: { device_ids: [] } });
  m = await me();
  assert.equal(find(m, joyPcId).group_id, null);
  assert.equal(m.groups.find((x: { id: string }) => x.id === joy).label, "Joy");

  // Reinstalling clare on a computer keeps its group, and its browser follows.
  r = await call("POST", "/enroll-code", { token: s.web, body: {} });
  r = await call("POST", "/enroll", { body: { code: r.data.code, kind: "cli", label: "Air", info: { machine_id: "air-1" } } });
  const air2 = r.data.token;
  assert.equal(r.data.status.group.id, pranav);
  r = await call("POST", "/check", { token: chrome });
  assert.equal(r.data.status.group.id, pranav);

  // Regular devices can't change groups.
  r = await call("POST", "/enroll-code", { token: s.web, body: {} });
  r = await call("POST", "/enroll", { body: { code: r.data.code, kind: "cli", label: "Kiosk", info: { machine_id: "kiosk" } } });
  const kiosk = r.data.token;
  for (const [method, path, body] of [
    ["POST", "/groups", { label: "x", budget_pct: 10 }],
    ["PATCH", `/groups/${joy}`, { budget_pct: 90 }],
    ["DELETE", `/groups/${joy}`, undefined],
  ] as const) {
    r = await call(method, path, { token: kiosk, body });
    assert.equal(r.status, 403, `${method} ${path}`);
  }

  // Deleting a group only takes its computers out of it.
  r = await call("DELETE", `/groups/${pranav}`, { token: s.web });
  assert.equal(r.status, 200);
  r = await call("POST", "/check", { token: air2 });
  assert.equal(r.data.status.group, null);
  assert.equal(r.data.status.state, "ok");
  assert.equal((await call("DELETE", `/groups/${pranav}`, { token: s.web })).status, 404);
  assert.equal((await call("PATCH", `/groups/${pranav}`, { token: s.web, body: {} })).status, 404);
});

test("usage clare couldn't see goes to a device added afterwards, when its link asks for that", async () => {
  const me = async () => (await call("GET", "/me", { token: s.web })).data;
  type Member = { id: string; claims_unobserved: boolean; usage: { points: number; claimed: number } };
  const find = (m: { devices: Member[] }, id: string) => m.devices.find((d) => d.id === id)!;
  const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 0.01, `${a} ≈ ${b}`);

  // A computer already on clare reads the meter twice; nothing clare saw explains the second rise.
  let r = await call("POST", "/enroll-code", { token: s.web, body: {} });
  r = await call("POST", "/enroll", { body: { code: r.data.code, kind: "cli", label: "Studio", info: { machine_id: "studio" } } });
  const studio = (s.studio = r.data.token);
  const reset = new Date(now.getTime() + 2 * DAY).toISOString();
  const reading = (pct: number) => ({ at: now.toISOString(), seven_day: { pct, resets_at: reset } });
  later(MIN);
  await call("POST", "/meter", { token: studio, body: reading(20) });
  const before = (await me()).account.unobserved;
  later(HOUR);
  r = await call("POST", "/meter", { token: studio, body: reading(30) });
  assert.equal(r.data.stored, true);
  const read = now.toISOString();
  let m = await me();
  close(m.account.unobserved, before + 10);
  assert.equal(m.account.claimed, 0);

  // Mom's computer joins a group from a link that takes that usage: it counts toward her and her group.
  later(MIN);
  r = await call("POST", "/groups", { token: s.web, body: { label: "family", budget_pct: 40 } });
  const family = r.data.id;
  r = await call("POST", "/enroll-code", { token: s.web, body: { group_id: family, claim_unobserved: true } });
  assert.equal(r.data.claim_unobserved, true);
  r = await call("POST", "/enroll", { body: { code: r.data.code, kind: "cli", label: "Mom's laptop", info: { machine_id: "mom-1" } } });
  const momId = r.data.device_id;
  assert.equal(r.data.status.meter_at, read, "status says when the meter was last read");
  close(r.data.status.group.used, before + 10);
  m = await me();
  close(find(m, momId).usage.claimed, before + 10);
  close(find(m, momId).usage.points, before + 10);
  assert.equal(find(m, momId).claims_unobserved, true);
  assert.equal(m.account.unobserved, 0);
  close(m.account.claimed, before + 10);

  // Switched off, it's unseen again; switched on from the dashboard, it's back.
  await call("PATCH", `/devices/${momId}`, { token: s.web, body: { claims_unobserved: false } });
  m = await me();
  assert.equal(find(m, momId).usage.points, 0);
  close(m.account.unobserved, before + 10);
  await call("PATCH", `/devices/${momId}`, { token: s.web, body: { claims_unobserved: true } });
  close(find(await me(), momId).usage.claimed, before + 10);

  // The next rise began before she was added, so it's hers too; after that, unseen usage stays unseen.
  later(HOUR);
  await call("POST", "/meter", { token: studio, body: reading(31) });
  later(HOUR);
  await call("POST", "/meter", { token: studio, body: reading(34) });
  m = await me();
  close(find(m, momId).usage.claimed, before + 11);
  close(m.account.unobserved, 3);

  // Only an admin's link can ask for it.
  r = await call("POST", "/enroll-code", { token: studio, body: { kind: "extension", claim_unobserved: true } });
  assert.equal(r.data.claim_unobserved, false);
});

test("a day without a meter reading raises one alert; the next reading clears it", async () => {
  type Alert = { kind: string; message: string };
  const stale = (alerts: Alert[]) => alerts.filter((a) => a.kind === "meter_stale");
  const me = async () => (await call("GET", "/me", { token: s.web })).data;
  const resets = (await me()).account.week.resets_at;

  later(23 * HOUR);
  assert.equal(stale((await me()).alerts).length, 0, "a quiet night isn't worth an alert");
  later(2 * HOUR);
  let r = await call("POST", "/heartbeat", { token: s.studio, body: {} });
  assert.deepEqual(stale(r.data.alerts).map((a) => a.message), [
    "Claude's usage meter hasn't been read for 25 hours, so usage on devices without clare isn't being counted. " +
    "Open claude.ai in Chrome on a computer with clare, or use Claude Code in a terminal, and clare will catch up.",
  ], "heartbeats deliver it, so browsers can show a notification");
  later(HOUR);
  assert.equal(stale((await me()).alerts).length, 1, "raised once");

  // Any reading clears it, even one with the same numbers; the next quiet day raises it again.
  await call("POST", "/meter", { token: s.studio, body: { at: now.toISOString(), seven_day: { pct: 34, resets_at: resets } } });
  assert.equal(stale((await me()).alerts).length, 0);
  later(24 * HOUR + MIN);
  assert.equal(stale((await me()).alerts).length, 1);
});
