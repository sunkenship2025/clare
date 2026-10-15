// Pure clare logic: rates, credits, meter readings, attribution, budgets, status copy.
// No I/O and no runtime-specific APIs, so it runs unchanged in Deno (edge) and Node (dev + tests).

export const VERSION = "0.2.3";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

// ── Rates ────────────────────────────────────────────────────

export type Family = "fable" | "opus" | "sonnet" | "haiku";

/** USD per million tokens — API list prices, used as relative weights for subscription usage. */
export interface Rate {
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
}

export const RATES: Record<Family, Rate> = {
  fable: { input: 10, output: 50, cache_read: 0.25, cache_write_5m: 12.5, cache_write_1h: 20 },
  opus: { input: 4, output: 20, cache_read: 0.2, cache_write_5m: 5, cache_write_1h: 8 },
  sonnet: { input: 2, output: 10, cache_read: 0.2, cache_write_5m: 2.5, cache_write_1h: 4 },
  haiku: { input: 0.1, output: 0.5, cache_read: 0.01, cache_write_5m: 0.125, cache_write_1h: 0.2 },
};

export function modelFamily(model: string | null | undefined): Family {
  const m = String(model ?? "").toLowerCase();
  if (m.includes("fable") || m.includes("mythos")) return "fable";
  if (m.includes("opus")) return "opus";
  if (m.includes("haiku")) return "haiku";
  return "sonnet";
}

export interface UsageEvent {
  key: string;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cache_write_1h: number;
  at: string;
  estimated: boolean;
}

/** Credits (API-price dollars) for one event. */
export function credits(e: Pick<UsageEvent, "model" | "input" | "output" | "cache_read" | "cache_write" | "cache_write_1h">): number {
  const r = RATES[modelFamily(e.model)];
  const write1h = Math.min(e.cache_write_1h, e.cache_write);
  const write5m = e.cache_write - write1h;
  const usd =
    e.input * r.input +
    e.output * r.output +
    e.cache_read * r.cache_read +
    write5m * r.cache_write_5m +
    write1h * r.cache_write_1h;
  return round6(usd / 1_000_000);
}

const MAX_TOKENS = 50_000_000; // per event; anything above is junk

function int(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_TOKENS) : 0;
}

/**
 * Validate and normalize a client-reported event. Returns null for junk.
 * `at` is clamped to [now − 8 days, now].
 */
export function normalizeEvent(raw: unknown, now: Date): UsageEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const key = typeof o.key === "string" ? o.key.slice(0, 200) : "";
  if (!key) return null;
  const e: UsageEvent = {
    key,
    model: typeof o.model === "string" ? o.model.slice(0, 100) : "unknown",
    input: int(o.input),
    output: int(o.output),
    cache_read: int(o.cache_read),
    cache_write: int(o.cache_write),
    cache_write_1h: int(o.cache_write_1h),
    at: now.toISOString(),
    estimated: o.estimated === true,
  };
  if (e.input + e.output + e.cache_read + e.cache_write === 0) return null;
  const t = Date.parse(String(o.at ?? ""));
  if (Number.isFinite(t)) {
    const clamped = Math.min(Math.max(t, now.getTime() - 8 * DAY_MS), now.getTime());
    e.at = new Date(clamped).toISOString();
  }
  return e;
}

// ── Meter readings ───────────────────────────────────────────

/** One official usage-meter reading, normalized. Percentages are points (1 point = 1% of the weekly limit). */
export interface Reading {
  at: Date;
  week_pct: number;
  week_resets_at: Date;
  five_pct: number | null;
  five_resets_at: Date | null;
}

/** ISO string, epoch seconds, or epoch milliseconds → Date. */
function parseTime(v: unknown): Date | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v < 1e12 ? v * 1000 : v);
  if (typeof v === "string" && v) {
    if (/^\d+(\.\d+)?$/.test(v)) return parseTime(Number(v));
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t);
  }
  return null;
}

function meterWindow(w: unknown): { pct: number; resets_at: Date | null } | null {
  if (!w || typeof w !== "object") return null;
  const o = w as Record<string, unknown>;
  const raw = o.pct ?? o.utilization;
  if (raw === undefined || raw === null || raw === "") return null;
  const pct = Number(raw);
  if (!Number.isFinite(pct) || pct < 0 || pct > 1000) return null;
  return { pct: round3(pct), resets_at: parseTime(o.resets_at) };
}

/**
 * Validate a canonical reading (`{ at, seven_day: { pct, resets_at }, five_hour? }`; `utilization` is accepted
 * for `pct`). Returns null for junk or a stale reading whose week has already reset.
 */
export function normalizeReading(raw: unknown, now: Date): Reading | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const week = meterWindow(o.seven_day);
  if (!week || !week.resets_at) return null;
  const reset = week.resets_at.getTime();
  if (!(reset > now.getTime() && reset <= now.getTime() + 8 * DAY_MS)) return null;
  const five = meterWindow(o.five_hour);
  const at = parseTime(o.at) ?? now;
  const clamped = Math.min(Math.max(at.getTime(), now.getTime() - DAY_MS), now.getTime());
  return {
    at: new Date(clamped),
    week_pct: week.pct,
    week_resets_at: week.resets_at,
    five_pct: five ? five.pct : null,
    five_resets_at: five ? five.resets_at : null,
  };
}

// ── Capacity & week window ───────────────────────────────────

export type Plan = "pro" | "max5" | "max20";

/** Rough starting guesses (credits/week), only used when the official meter can't be read. */
export const PLAN_CAPACITY: Record<Plan, number> = { pro: 60, max5: 300, max20: 1200 };

export interface CapacitySettings {
  plan: Plan;
  capacity_manual: number | null;
  capacity_calibrated: number | null;
}

export function capacity(s: CapacitySettings): { value: number; source: "manual" | "calibrated" | "plan" } {
  if (s.capacity_manual != null && Number(s.capacity_manual) > 0) {
    return { value: Number(s.capacity_manual), source: "manual" };
  }
  if (s.capacity_calibrated != null && Number(s.capacity_calibrated) > 0) {
    return { value: Number(s.capacity_calibrated), source: "calibrated" };
  }
  return { value: PLAN_CAPACITY[s.plan] ?? PLAN_CAPACITY.max5, source: "plan" };
}

/** The 7-day window containing `now`, aligned to `anchor` (a known reset instant). */
export function weekWindow(anchor: Date, now: Date): { start: Date; end: Date } {
  const k = Math.floor((now.getTime() - anchor.getTime()) / WEEK_MS) + 1;
  const end = new Date(anchor.getTime() + k * WEEK_MS);
  return { start: new Date(end.getTime() - WEEK_MS), end };
}

/**
 * Fold this week's attribution into the capacity estimate (credits per full week).
 * Needs at least 5 attributed points to be worth anything.
 */
export function calibrate(prev: number | null, attributedCredits: number, attributedPoints: number): number | null {
  if (!(attributedPoints >= 5) || !(attributedCredits > 0)) return prev;
  const implied = (attributedCredits / attributedPoints) * 100;
  if (prev == null || !(prev > 0)) return round2(implied);
  return round2(0.7 * prev + 0.3 * implied);
}

// ── Attribution ──────────────────────────────────────────────

export interface ReadingPoint {
  at: Date;
  week_pct: number;
  week_resets_at: Date;
}

export interface Activity {
  device_id: string | null;
  at: Date;
  credits: number;
}

export interface DeviceUsage {
  points: number; // attributed + pending
  attributed: number;
  pending: number;
  credits: number;
}

export interface Attribution {
  basis: "meter" | "estimate";
  week: { start: Date; end: Date };
  used: number; // account points: official meter (running max) + pending, or Σ estimate
  meter_pct: number | null; // official weekly %, running max, null on estimate basis
  observed: number; // attributed to enrolled devices
  unobserved: number; // meter rises with no clare activity behind them
  before_clare: number; // already used this week when clare was set up
  pending: number; // activity the meter doesn't show yet, estimated
  points_per_credit: number;
  attributed_points: number;
  attributed_credits: number;
  devices: Map<string, DeviceUsage>;
}

const SAME_WEEK_MS = HOUR_MS;

/** The official week from the newest reading that hasn't reset yet, else the anchored fallback window. */
export function pickWeek(
  readings: ReadingPoint[],
  now: Date,
  anchor: Date,
): { basis: "meter" | "estimate"; start: Date; end: Date } {
  let newest: ReadingPoint | null = null;
  for (const r of readings) {
    if (r.at.getTime() > now.getTime() || r.week_resets_at.getTime() <= now.getTime()) continue;
    if (!newest || r.at.getTime() >= newest.at.getTime()) newest = r;
  }
  if (newest) {
    const end = newest.week_resets_at;
    return { basis: "meter", start: new Date(end.getTime() - WEEK_MS), end };
  }
  return { basis: "estimate", ...weekWindow(anchor, now) };
}

export interface AttributionInput {
  readings: ReadingPoint[];
  activity: Activity[];
  now: Date;
  createdAt: Date; // when clare was set up
  anchor: Date; // fallback week anchor (the last known reset)
  capacity: number; // credits per week, for estimates
}

/**
 * Split the official meter's rises between devices in proportion to the activity clare saw between readings.
 * See "Metering" in docs/ARCHITECTURE.md.
 */
export function attribute(i: AttributionInput): Attribution {
  const week = pickWeek(i.readings, i.now, i.anchor);
  const start = week.start.getTime();
  const nowMs = i.now.getTime();
  const fallbackPpc = i.capacity > 0 ? 100 / i.capacity : 0;
  const devices = new Map<string, DeviceUsage>();
  const dev = (id: string | null) => {
    const k = id ?? "";
    let d = devices.get(k);
    if (!d) devices.set(k, (d = { points: 0, attributed: 0, pending: 0, credits: 0 }));
    return d;
  };

  const activity = i.activity
    .filter((a) => a.at.getTime() >= start && a.at.getTime() <= nowMs && a.credits > 0)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const a of activity) dev(a.device_id).credits += a.credits;

  if (week.basis === "estimate") {
    let used = 0;
    for (const d of devices.values()) {
      d.points = round3(d.credits * fallbackPpc);
      used += d.points;
    }
    return {
      basis: "estimate",
      week: { start: week.start, end: week.end },
      used: round3(used),
      meter_pct: null,
      observed: round3(used),
      unobserved: 0,
      before_clare: 0,
      pending: 0,
      points_per_credit: fallbackPpc,
      attributed_points: 0,
      attributed_credits: 0,
      devices,
    };
  }

  const end = week.end.getTime();
  const readings = i.readings
    .filter((r) => Math.abs(r.week_resets_at.getTime() - end) <= SAME_WEEK_MS && r.at.getTime() >= start && r.at.getTime() <= nowMs)
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  // Baseline: 0% at week start if clare already existed, else the first reading this week.
  let max = 0;
  let beforeClare = 0;
  let from = start - 1; // activity strictly after this counts
  let walk = readings;
  if (i.createdAt.getTime() > start && readings.length) {
    max = beforeClare = readings[0].week_pct;
    from = readings[0].at.getTime();
    walk = readings.slice(1);
  }

  const acc = new Map<string, number>();
  let accTotal = 0;
  let unobserved = 0;
  let attributedPoints = 0;
  let attributedCredits = 0;
  let k = 0;
  const take = (until: number) => {
    for (; k < activity.length && activity[k].at.getTime() <= until; k++) {
      const a = activity[k];
      if (a.at.getTime() <= from) continue;
      const id = a.device_id ?? "";
      acc.set(id, (acc.get(id) ?? 0) + a.credits);
      accTotal += a.credits;
    }
  };

  for (const r of walk) {
    take(r.at.getTime());
    const rise = r.week_pct - max;
    if (rise <= 1e-9) continue; // same step or a dip: keep accumulating
    if (accTotal > 0) {
      for (const [id, c] of acc) dev(id).attributed += (rise * c) / accTotal;
      attributedPoints += rise;
      attributedCredits += accTotal;
      acc.clear();
      accTotal = 0;
    } else {
      unobserved += rise;
    }
    max = r.week_pct;
  }
  take(nowMs);

  const ppc = attributedPoints >= 1 && attributedCredits > 0 ? attributedPoints / attributedCredits : fallbackPpc;
  let pending = 0;
  let observed = 0;
  for (const [id, d] of devices) {
    d.pending = round3((acc.get(id) ?? 0) * ppc);
    d.attributed = round3(d.attributed);
    d.points = round3(d.attributed + d.pending);
    pending += d.pending;
    observed += d.attributed;
  }

  return {
    basis: "meter",
    week: { start: week.start, end: week.end },
    used: round3(max + pending),
    meter_pct: max,
    observed: round3(observed),
    unobserved: round3(unobserved),
    before_clare: round3(beforeClare),
    pending: round3(pending),
    points_per_credit: ppc,
    attributed_points: round3(attributedPoints),
    attributed_credits: round6(attributedCredits),
    devices,
  };
}

// ── Status ───────────────────────────────────────────────────

export type State = "ok" | "warn" | "over" | "blocked";

export interface Status {
  allowed: boolean;
  state: State;
  basis: "meter" | "estimate";
  scope: "account" | "device";
  used: number;
  limit: number;
  pct: number;
  account: { used: number; budget: number; pct: number };
  device: { id: string; label: string; used: number; budget: number | null; pct: number | null } | null;
  resets_at: string;
  enforce: boolean;
  strict_hooks: boolean;
  title: string;
  message: string;
}

export interface StatusInput {
  account: { used: number; budget: number; warn_pct: number; enforce: boolean; strict_hooks: boolean };
  device: { id: string; label: string; used: number; budget: number | null } | null;
  basis: "meter" | "estimate";
  resets_at: Date;
  now: Date;
  tz: string;
}

function pctOf(used: number, limit: number): number {
  if (limit > 0) return round1((used / limit) * 100);
  return used > 0 ? 100 : 0;
}

export function evaluate(i: StatusInput): Status {
  const account = { used: round2(i.account.used), budget: i.account.budget, pct: pctOf(i.account.used, i.account.budget) };
  const device = i.device
    ? {
      id: i.device.id,
      label: i.device.label,
      used: round2(i.device.used),
      budget: i.device.budget,
      pct: i.device.budget != null ? pctOf(i.device.used, i.device.budget) : null,
    }
    : null;
  const byDevice = device != null && device.pct != null && device.pct > account.pct;
  const scope = byDevice ? "device" : "account";
  const used = byDevice ? device!.used : account.used;
  const limit = byDevice ? device!.budget! : account.budget;
  const pct = byDevice ? device!.pct! : account.pct;

  let state: State = "ok";
  if (pct >= 100) state = i.account.enforce ? "blocked" : "over";
  else if (pct >= i.account.warn_pct) state = "warn";

  const when = refillPhrase(i.resets_at, i.now, i.tz);
  const about = i.basis === "estimate" ? "about " : "";
  const p = Math.floor(pct);
  const label = device?.label ?? "This device";
  let message: string;
  if (scope === "account") {
    message = {
      ok: `You've used ${about}${p}% of this week's Claude budget.`,
      warn: `Heads up: you've used ${about}${p}% of this week's Claude budget. It resets ${when}.`,
      blocked: `You've used all of this week's Claude budget. It resets ${when}. You can change the budget in the clare dashboard.`,
      over: `You're over this week's Claude budget (monitor only, nothing is blocked). It resets ${when}.`,
    }[state];
  } else {
    message = {
      ok: `${label} has used ${about}${p}% of its weekly budget.`,
      warn: `Heads up: ${label} has used ${about}${p}% of its weekly budget. It resets ${when}.`,
      blocked: `${label} has used all of its weekly budget. It resets ${when}. You can change it in the clare dashboard.`,
      over: `${label} is over its weekly budget (monitor only, nothing is blocked). It resets ${when}.`,
    }[state];
  }
  const title = state === "blocked" ? "Budget used up" : state === "over" ? "Over budget" : `${about ? "~" : ""}${p}% used`;

  return {
    allowed: state !== "blocked",
    state,
    basis: i.basis,
    scope,
    used,
    limit,
    pct,
    account,
    device,
    resets_at: i.resets_at.toISOString(),
    enforce: i.account.enforce,
    strict_hooks: i.account.strict_hooks,
    title,
    message,
  };
}

/** "today at 9:30 PM", "tomorrow at 9:30 PM", "on Monday at 9:30 PM", "on Oct 20 at 9:30 PM". */
export function refillPhrase(at: Date, now: Date, tz: string): string {
  const zone = safeZone(tz);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(at);
  const dayKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(d);
  const days = Math.round((Date.parse(dayKey(at)) - Date.parse(dayKey(now))) / DAY_MS);
  if (days <= 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days < 7) {
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(at);
    return `on ${weekday} at ${time}`;
  }
  const date = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric" }).format(at);
  return `on ${date} at ${time}`;
}

export function safeZone(tz: string | null | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

export function fmtPct(n: number): string {
  const r = Math.round(n * 10) / 10;
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)}%`;
}

// ── Devices ──────────────────────────────────────────────────

export type Connectivity = "online" | "offline" | "removed" | "problem";
export type Enforcement = "active" | "unverified" | "removed";

export const ONLINE_MS = 12 * 60_000;
export const OFFLINE_ALERT_MS = 48 * HOUR_MS;

export function connectivity(
  d: { removed_at: Date | string | null; problem: string | null; last_seen_at: Date | string | null },
  now: Date,
): Connectivity {
  if (d.removed_at) return "removed";
  if (d.problem) return "problem";
  if (d.last_seen_at && now.getTime() - new Date(d.last_seen_at).getTime() < ONLINE_MS) return "online";
  return "offline";
}

/** Can clare vouch that this device's budget is being enforced right now? */
export function enforcement(c: Connectivity): Enforcement {
  return c === "removed" ? "removed" : c === "online" ? "active" : "unverified";
}

export function deviceKindName(kind: string): string {
  return kind === "cli" ? "Claude Code" : kind === "extension" ? "Chrome extension" : "Dashboard";
}

// ── Rounding ─────────────────────────────────────────────────

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
