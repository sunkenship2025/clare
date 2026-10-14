import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attribute,
  calibrate,
  capacity,
  connectivity,
  credits,
  enforcement,
  evaluate,
  modelFamily,
  normalizeEvent,
  normalizeReading,
  pickWeek,
  refillPhrase,
  weekWindow,
} from "../supabase/functions/_shared/core.ts";

const H = 3_600_000;
const D = 24 * H;

test("model families", () => {
  assert.equal(modelFamily("claude-opus-5-5"), "opus");
  assert.equal(modelFamily("claude-fable-5-1"), "fable");
  assert.equal(modelFamily("claude-mythos-5-1"), "fable");
  assert.equal(modelFamily("claude-haiku-5-5"), "haiku");
  assert.equal(modelFamily("claude-sonnet-5-5"), "sonnet");
  assert.equal(modelFamily("something-new"), "sonnet");
  assert.equal(modelFamily(undefined), "sonnet");
});

test("credits use API list prices with 1h vs 5m cache writes", () => {
  // A real transcript sample: opus, 2 in, 1254 out, 23744 cache read, 14497 1h write.
  const c = credits({ model: "claude-opus-5-5", input: 2, output: 1254, cache_read: 23744, cache_write: 14497, cache_write_1h: 14497 });
  const expected = (2 * 4 + 1254 * 20 + 23744 * 0.2 + 14497 * 8) / 1e6;
  assert.ok(Math.abs(c - expected) < 1e-6, `${c} vs ${expected}`);
  const fiveMin = credits({ model: "claude-opus-5-5", input: 0, output: 0, cache_read: 0, cache_write: 1_000_000, cache_write_1h: 0 });
  assert.equal(fiveMin, 5);
  // 1h subset can't exceed the total
  const weird = credits({ model: "opus", input: 0, output: 0, cache_read: 0, cache_write: 100, cache_write_1h: 999 });
  assert.equal(weird, (100 * 8) / 1e6);
});

test("normalizeEvent rejects junk and clamps time", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  assert.equal(normalizeEvent(null, now), null);
  assert.equal(normalizeEvent({ key: "" }, now), null);
  assert.equal(normalizeEvent({ key: "k", model: "opus", input: 0, output: 0 }, now), null);
  const old = normalizeEvent({ key: "k", model: "opus", output: 5, at: "2020-01-01T00:00:00Z" }, now)!;
  assert.equal(old.at, new Date(now.getTime() - 8 * D).toISOString());
  const future = normalizeEvent({ key: "k", model: "opus", output: 5, at: "2030-01-01T00:00:00Z" }, now)!;
  assert.equal(future.at, now.toISOString());
  const neg = normalizeEvent({ key: "k", output: -5, input: "12" }, now)!;
  assert.equal(neg.output, 0);
  assert.equal(neg.input, 12);
});

test("normalizeReading: canonical shape, utilization alias, epoch times, staleness", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  const r = normalizeReading({
    at: "2026-10-14T11:59:00Z",
    seven_day: { pct: 41.2, resets_at: "2026-10-19T16:00:00Z" },
    five_hour: { pct: 23.5, resets_at: "2026-10-14T13:00:00Z" },
  }, now)!;
  assert.equal(r.week_pct, 41.2);
  assert.equal(r.week_resets_at.toISOString(), "2026-10-19T16:00:00.000Z");
  assert.equal(r.five_pct, 23.5);
  assert.equal(r.at.toISOString(), "2026-10-14T11:59:00.000Z");

  // claude.ai shape and epoch seconds
  const alias = normalizeReading({ seven_day: { utilization: 7, resets_at: Date.parse("2026-10-19T16:00:00Z") / 1000 } }, now)!;
  assert.equal(alias.week_pct, 7);
  assert.equal(alias.week_resets_at.toISOString(), "2026-10-19T16:00:00.000Z");
  assert.equal(alias.at.getTime(), now.getTime(), "missing at → now");
  assert.equal(alias.five_pct, null);

  assert.equal(normalizeReading({ seven_day: { pct: 5 } }, now), null, "no reset time");
  assert.equal(normalizeReading({ five_hour: { pct: 5, resets_at: "2026-10-14T18:00:00Z" } }, now), null, "weekly required");
  assert.equal(normalizeReading({ seven_day: { pct: -1, resets_at: "2026-10-19T16:00:00Z" } }, now), null);
  assert.equal(normalizeReading({ seven_day: { pct: 10, resets_at: "2026-10-13T16:00:00Z" } }, now), null, "already reset");
  assert.equal(normalizeReading({ seven_day: { pct: 10, resets_at: "2026-11-30T16:00:00Z" } }, now), null, "too far out");
  const future = normalizeReading({ at: "2030-01-01T00:00:00Z", seven_day: { pct: 1, resets_at: "2026-10-19T16:00:00Z" } }, now)!;
  assert.equal(future.at.getTime(), now.getTime(), "at clamped to now");
});

test("capacity source precedence", () => {
  assert.deepEqual(capacity({ plan: "max5", capacity_manual: null, capacity_calibrated: null }), { value: 300, source: "plan" });
  assert.deepEqual(capacity({ plan: "max5", capacity_manual: null, capacity_calibrated: 410 }), { value: 410, source: "calibrated" });
  assert.deepEqual(capacity({ plan: "max5", capacity_manual: 200, capacity_calibrated: 410 }), { value: 200, source: "manual" });
});

test("week window aligns to the anchor", () => {
  const anchor = new Date("2026-10-12T16:00:00Z");
  const w = weekWindow(anchor, new Date("2026-10-14T12:00:00Z"));
  assert.equal(w.start.toISOString(), "2026-10-12T16:00:00.000Z");
  assert.equal(w.end.toISOString(), "2026-10-19T16:00:00.000Z");
  const at = weekWindow(anchor, new Date("2026-10-19T16:00:00Z"));
  assert.equal(at.start.toISOString(), "2026-10-19T16:00:00.000Z");
  const fut = weekWindow(new Date("2026-10-19T16:00:00Z"), new Date("2026-10-14T12:00:00Z"));
  assert.equal(fut.end.toISOString(), "2026-10-19T16:00:00.000Z");
});

test("calibration needs 5 attributed points and blends 70/30", () => {
  assert.equal(calibrate(null, 30, 4), null);
  assert.equal(calibrate(250, 30, 4), 250);
  assert.equal(calibrate(null, 60, 20), 300);
  assert.equal(calibrate(300, 100, 25), 330); // implies 400
});

// ── Attribution ──────────────────────────────────────────────

const RESET = new Date("2026-10-19T16:00:00Z");
const START = new Date(RESET.getTime() - 7 * D); // Mon Oct 12 16:00
const t = (h: number) => new Date(START.getTime() + h * H);
const reading = (h: number, pct: number, reset = RESET) => ({ at: t(h), week_pct: pct, week_resets_at: reset });
const act = (device: string | null, h: number, c: number) => ({ device_id: device, at: t(h), credits: c });
const base = { now: t(50), createdAt: new Date(START.getTime() - 3 * D), anchor: START, capacity: 300 };

test("pickWeek prefers the newest unexpired reading, else the anchored window", () => {
  const w = pickWeek([reading(10, 5), reading(20, 9)], t(50), START);
  assert.equal(w.basis, "meter");
  assert.equal(w.end.toISOString(), RESET.toISOString());
  const stale = pickWeek([{ at: t(-30), week_pct: 80, week_resets_at: START }], t(50), START);
  assert.equal(stale.basis, "estimate");
  assert.equal(stale.end.toISOString(), RESET.toISOString());
});

test("meter rises are split between devices in proportion to activity", () => {
  const a = attribute({
    ...base,
    readings: [reading(1, 0), reading(10, 4), reading(20, 10)],
    activity: [act("mac", 5, 3), act("pc", 6, 1), act("mac", 15, 2)],
  });
  assert.equal(a.basis, "meter");
  assert.equal(a.meter_pct, 10);
  assert.equal(a.devices.get("mac")!.attributed, 3 + 6); // 3/4 of the first 4 points, all of the next 6
  assert.equal(a.devices.get("pc")!.attributed, 1);
  assert.equal(a.observed, 10);
  assert.equal(a.unobserved, 0);
  assert.equal(a.before_clare, 0);
  assert.equal(a.used, 10);
  assert.equal(a.points_per_credit, 10 / 6);
});

test("rises with no clare activity are unobserved; dips are ignored", () => {
  const a = attribute({
    ...base,
    readings: [reading(10, 3), reading(20, 3), reading(25, 2.5), reading(30, 8)],
    activity: [act("mac", 5, 1)],
  });
  assert.equal(a.devices.get("mac")!.attributed, 3);
  assert.equal(a.unobserved, 5);
  assert.equal(a.used, 8);
});

test("a flat meter keeps accumulating until the next step", () => {
  const a = attribute({
    ...base,
    readings: [reading(10, 1), reading(12, 1), reading(14, 2)],
    activity: [act("mac", 9, 1), act("pc", 11, 1), act("pc", 13, 1)],
  });
  // First point is all mac's; the second point covers pc's two pieces of work.
  assert.equal(a.devices.get("mac")!.attributed, 1);
  assert.equal(a.devices.get("pc")!.attributed, 1);
});

test("activity after the last reading is pending, estimated at this week's rate", () => {
  const a = attribute({
    ...base,
    readings: [reading(10, 4)],
    activity: [act("mac", 5, 2), act("mac", 30, 1), act("pc", 31, 0.5)],
  });
  assert.equal(a.points_per_credit, 2);
  assert.equal(a.devices.get("mac")!.pending, 2);
  assert.equal(a.devices.get("pc")!.pending, 1);
  assert.equal(a.devices.get("mac")!.points, 6);
  assert.equal(a.pending, 3);
  assert.equal(a.used, 7);
});

test("too little signal falls back to 100 / capacity for pending", () => {
  const a = attribute({ ...base, readings: [reading(10, 0.5)], activity: [act("mac", 5, 1), act("mac", 20, 3)] });
  assert.equal(a.points_per_credit, 100 / 300);
  assert.equal(a.devices.get("mac")!.pending, 1);
});

test("set up mid-week: the first reading is the baseline, earlier usage is before_clare", () => {
  const a = attribute({
    ...base,
    createdAt: t(40),
    readings: [reading(41, 30), reading(45, 33)],
    activity: [act("mac", 39, 5), act("mac", 44, 1)],
  });
  assert.equal(a.before_clare, 30);
  assert.equal(a.devices.get("mac")!.attributed, 3);
  assert.equal(a.unobserved, 0);
  assert.equal(a.used, 33);
});

test("readings from another week are ignored", () => {
  const a = attribute({
    ...base,
    readings: [{ at: t(-20), week_pct: 90, week_resets_at: START }, reading(10, 2)],
    activity: [act("mac", 5, 1)],
  });
  assert.equal(a.meter_pct, 2);
  assert.equal(a.devices.get("mac")!.attributed, 2);
});

test("estimate basis when there is no reading this week", () => {
  const a = attribute({ ...base, readings: [], activity: [act("mac", 5, 30), act("pc", 6, 15), act("mac", -10, 99)] });
  assert.equal(a.basis, "estimate");
  assert.equal(a.meter_pct, null);
  assert.equal(a.devices.get("mac")!.points, 10);
  assert.equal(a.devices.get("pc")!.points, 5);
  assert.equal(a.used, 15);
});

// ── Status ───────────────────────────────────────────────────

const statusBase = {
  account: { used: 20, budget: 90, warn_pct: 80, enforce: true, strict_hooks: false },
  device: { id: "d1", label: "MacBook Air", used: 5, budget: null },
  basis: "meter" as const,
  resets_at: RESET,
  now: new Date("2026-10-14T12:00:00Z"),
  tz: "Asia/Kolkata",
};

test("status: account budget states and copy", () => {
  const ok = evaluate(statusBase);
  assert.equal(ok.state, "ok");
  assert.equal(ok.scope, "account");
  assert.equal(ok.limit, 90);
  assert.equal(ok.pct, 22.2);
  assert.equal(ok.allowed, true);
  assert.equal(ok.title, "22% used");
  assert.equal(ok.message, "You've used 22% of this week's Claude budget.");
  assert.deepEqual(ok.device, { id: "d1", label: "MacBook Air", used: 5, budget: null, pct: null });

  const warn = evaluate({ ...statusBase, account: { ...statusBase.account, used: 76.5 } });
  assert.equal(warn.state, "warn");
  assert.equal(warn.message, "Heads up: you've used 85% of this week's Claude budget. It resets on Monday at 9:30 PM.");

  const blocked = evaluate({ ...statusBase, account: { ...statusBase.account, used: 90 } });
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.title, "Budget used up");
  assert.equal(blocked.message,
    "You've used all of this week's Claude budget. It resets on Monday at 9:30 PM. You can change the budget in the clare dashboard.");

  const over = evaluate({ ...statusBase, account: { ...statusBase.account, used: 95, enforce: false } });
  assert.equal(over.state, "over");
  assert.equal(over.allowed, true);
  assert.equal(over.enforce, false);
  assert.match(over.message, /monitor only, nothing is blocked/);
});

test("status: a device cap binds when it's tighter", () => {
  const s = evaluate({ ...statusBase, device: { id: "d1", label: "MacBook Air", used: 30, budget: 30 } });
  assert.equal(s.scope, "device");
  assert.equal(s.state, "blocked");
  assert.equal(s.used, 30);
  assert.equal(s.limit, 30);
  assert.equal(s.account.pct, 22.2);
  assert.equal(s.message,
    "MacBook Air has used all of its weekly budget. It resets on Monday at 9:30 PM. You can change it in the clare dashboard.");

  const loose = evaluate({ ...statusBase, device: { id: "d1", label: "MacBook Air", used: 2, budget: 50 } });
  assert.equal(loose.scope, "account");
  assert.equal(loose.device!.pct, 4);
});

test("status: dashboards have no device, estimates say about", () => {
  const s = evaluate({ ...statusBase, device: null, basis: "estimate" });
  assert.equal(s.device, null);
  assert.equal(s.basis, "estimate");
  assert.equal(s.title, "~22% used");
  assert.equal(s.message, "You've used about 22% of this week's Claude budget.");
});

test("refill phrases", () => {
  const now = new Date("2026-10-14T12:00:00Z"); // Wed 5:30 PM IST
  assert.equal(refillPhrase(new Date("2026-10-14T15:00:00Z"), now, "Asia/Kolkata"), "today at 8:30 PM");
  assert.equal(refillPhrase(new Date("2026-10-15T15:00:00Z"), now, "Asia/Kolkata"), "tomorrow at 8:30 PM");
  assert.equal(refillPhrase(new Date("2026-10-19T16:00:00Z"), now, "Asia/Kolkata"), "on Monday at 9:30 PM");
  assert.equal(refillPhrase(new Date("2026-10-19T16:00:00Z"), now, "Not/AZone"), "on Monday at 4:00 PM");
});

test("connectivity and enforcement", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  assert.equal(connectivity({ removed_at: now, problem: null, last_seen_at: now }, now), "removed");
  assert.equal(connectivity({ removed_at: null, problem: "hooks missing", last_seen_at: now }, now), "problem");
  assert.equal(connectivity({ removed_at: null, problem: null, last_seen_at: new Date(now.getTime() - 5 * 60_000) }, now), "online");
  assert.equal(connectivity({ removed_at: null, problem: null, last_seen_at: new Date(now.getTime() - 60 * 60_000) }, now), "offline");
  assert.equal(connectivity({ removed_at: null, problem: null, last_seen_at: null }, now), "offline");
  assert.equal(enforcement("online"), "active");
  assert.equal(enforcement("offline"), "unverified");
  assert.equal(enforcement("problem"), "unverified");
  assert.equal(enforcement("removed"), "removed");
});
