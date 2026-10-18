// Pure clare logic: rates, credits, meter readings, attribution, budgets, status copy.
// No I/O and no runtime-specific APIs, so it runs unchanged in Deno (edge) and Node (dev + tests).

export const VERSION = "0.2.7";

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

export type Source = "cli" | "web";

export interface Activity {
  device_id: string | null;
  at: Date;
  credits: number;
  source?: Source; // cli = Claude Code (exact tokens), web = claude.ai (estimated from the page)
}

// ── Learned rates ────────────────────────────────────────────
//
// Claude Code counts tokens exactly; the extension estimates claude.ai's from the page, so the
// two can be off from each other. Meter rises during which only one source was active are clean
// samples of how many points a credit of that source really costs. They're folded into decayed
// sums (half-life 14 days), and once both sources have enough, each source's credits are
// weighted by its rate when splitting rises and estimating.

/** Decayed sums of clean samples for one source. */
export interface SourceRate {
  points: number;
  credits: number;
}

export interface LearnedRates {
  cli?: SourceRate;
  web?: SourceRate;
  at?: string; // when the sums were last decayed
}

export interface Sample {
  source: Source;
  points: number;
  credits: number;
  at: Date;
}

export const RATE_MIN_POINTS = 3;
const RATE_HALF_LIFE_MS = 14 * DAY_MS;

/** Points per credit learned for a source, or null without enough samples. */
export function learnedRate(rates: LearnedRates | null | undefined, src: Source): number | null {
  const r = rates?.[src];
  return r && r.points >= RATE_MIN_POINTS && r.credits > 0 ? r.points / r.credits : null;
}

/**
 * How much one credit of each source weighs relative to Claude Code (cli = 1). Both sources
 * need enough samples; until then every credit weighs the same.
 */
export function sourceWeights(rates: LearnedRates | null | undefined): Record<Source, number> {
  const cli = learnedRate(rates, "cli");
  const web = learnedRate(rates, "web");
  if (cli == null || web == null) return { cli: 1, web: 1 };
  // Clamp: a wild ratio is more likely noise (e.g. unobserved use during a "solo" window).
  return { cli: 1, web: Math.min(5, Math.max(0.2, web / cli)) };
}

/** Fold new samples into the learned sums, decaying older ones. */
export function learnRates(prev: LearnedRates | null | undefined, samples: Sample[]): LearnedRates {
  const out: LearnedRates = {
    cli: prev?.cli ? { ...prev.cli } : undefined,
    web: prev?.web ? { ...prev.web } : undefined,
    at: prev?.at,
  };
  for (const smp of [...samples].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const last = out.at ? Date.parse(out.at) : smp.at.getTime();
    const decay = Math.pow(0.5, Math.max(0, smp.at.getTime() - last) / RATE_HALF_LIFE_MS);
    for (const k of ["cli", "web"] as const) {
      const r = out[k];
      if (r) out[k] = { points: round6(r.points * decay), credits: round6(r.credits * decay) };
    }
    const r = out[smp.source] ?? { points: 0, credits: 0 };
    out[smp.source] = { points: round6(r.points + smp.points), credits: round6(r.credits + smp.credits) };
    out.at = new Date(Math.max(last, smp.at.getTime())).toISOString();
  }
  return out;
}

export interface DeviceUsage {
  points: number; // attributed + pending + claimed
  attributed: number;
  pending: number;
  claimed: number; // usage clare couldn't see from before this device was added, counted toward it
  credits: number;
}

export interface Attribution {
  basis: "meter" | "estimate";
  week: { start: Date; end: Date };
  used: number; // account points: official meter (running max) + pending, or Σ estimate
  meter_pct: number | null; // official weekly %, running max, null on estimate basis
  observed: number; // attributed to enrolled devices
  unobserved: number; // meter rises clare's activity doesn't explain, not claimed by a device
  claimed: number; // unseen usage counted toward the device added after it (see AttributionInput.claims)
  before_clare: number; // already used this week when clare was set up
  pending: number; // activity the meter doesn't show yet, estimated
  points_per_credit: number;
  attributed_points: number;
  attributed_credits: number;
  devices: Map<string, DeviceUsage>;
  samples: Sample[]; // this week's single-source rises, for learnRates
}

/**
 * A rise is split between the devices active since the last one, but no device is charged more
 * than this many times what its own activity should cost; the rest was used where clare couldn't
 * see it. Loose while the rate is only the plan's guess, tighter once it's learned.
 */
export const EXPLAIN_FACTOR = { guess: 10, learned: 5 };
/** The meter moves in whole points, so up to one point of a rise may be rounding. */
const ROUNDING_POINTS = 1;

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
  capacity_learned?: boolean; // capacity was calibrated or set by hand, not the plan's guess
  rates?: LearnedRates | null; // learned per-source rates (see learnRates)
  /**
   * Devices that take the usage clare couldn't see from before they were added: an unseen part
   * of a rise goes to the first such device added after the rise's interval began.
   */
  claims?: { device_id: string; until: Date }[];
}

/**
 * Split the official meter's rises between devices in proportion to the activity clare saw between readings.
 * See "Metering" in docs/ARCHITECTURE.md.
 */
export function attribute(i: AttributionInput): Attribution {
  const week = pickWeek(i.readings, i.now, i.anchor);
  const start = week.start.getTime();
  const nowMs = i.now.getTime();
  const weights = sourceWeights(i.rates);
  const tuned = weights.web !== 1;
  // Points per (weighted) credit with nothing better to go on: the learned Claude Code rate once
  // sources are weighted against it, else the plan's capacity.
  const fallbackPpc = (tuned ? learnedRate(i.rates, "cli") : null) ?? (i.capacity > 0 ? 100 / i.capacity : 0);
  const devices = new Map<string, DeviceUsage>();
  const dev = (id: string | null) => {
    const k = id ?? "";
    let d = devices.get(k);
    if (!d) devices.set(k, (d = { points: 0, attributed: 0, pending: 0, claimed: 0, credits: 0 }));
    return d;
  };

  const activity = i.activity
    .filter((a) => a.at.getTime() >= start && a.at.getTime() <= nowMs && a.credits > 0)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const weightOf = (a: Activity) => a.credits * weights[a.source ?? "cli"];
  for (const a of activity) dev(a.device_id).credits += a.credits;

  if (week.basis === "estimate") {
    let used = 0;
    const weighted = new Map<string, number>();
    for (const a of activity) weighted.set(a.device_id ?? "", (weighted.get(a.device_id ?? "") ?? 0) + weightOf(a));
    for (const [id, d] of devices) {
      d.points = round3((weighted.get(id) ?? 0) * fallbackPpc);
      used += d.points;
    }
    return {
      basis: "estimate",
      week: { start: week.start, end: week.end },
      used: round3(used),
      meter_pct: null,
      observed: round3(used),
      unobserved: 0,
      claimed: 0,
      before_clare: 0,
      pending: 0,
      points_per_credit: fallbackPpc,
      attributed_points: 0,
      attributed_credits: 0,
      devices,
      samples: [],
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

  // Weighted credits per device since the last rise, and raw credits per source (for samples).
  const acc = new Map<string, number>();
  let accTotal = 0;
  const accSrc: Record<Source, number> = { cli: 0, web: 0 };
  const samples: Sample[] = [];
  let unobserved = 0;
  let claimed = 0;
  let attributedPoints = 0;
  let attributedCredits = 0;
  let k = 0;
  const take = (until: number) => {
    for (; k < activity.length && activity[k].at.getTime() <= until; k++) {
      const a = activity[k];
      if (a.at.getTime() <= from) continue;
      const id = a.device_id ?? "";
      const w = weightOf(a);
      acc.set(id, (acc.get(id) ?? 0) + w);
      accTotal += w;
      accSrc[a.source ?? "cli"] += a.credits;
    }
  };

  const factor = i.capacity_learned || tuned ? EXPLAIN_FACTOR.learned : EXPLAIN_FACTOR.guess;
  const claims = [...(i.claims ?? [])].sort((a, b) => a.until.getTime() - b.until.getTime());
  let slack = ROUNDING_POINTS; // rounding room, carried between rises but never more than a point
  let since = Math.max(from, start); // when the current rise's interval began
  for (const r of walk) {
    take(r.at.getTime());
    const rise = r.week_pct - max;
    if (rise <= 1e-9) continue; // same step or a dip: keep accumulating
    const room = accTotal > 0 ? factor * accTotal * fallbackPpc : 0;
    const explained = accTotal > 0 ? Math.min(rise, room + slack) : 0;
    if (explained > 0) {
      for (const [id, c] of acc) dev(id).attributed += (explained * c) / accTotal;
      slack = Math.min(ROUNDING_POINTS, room + slack - explained);
    }
    // Only rises the activity fully explains teach clare what a credit costs.
    if (accTotal > 0 && rise <= room + 1e-9) {
      attributedPoints += rise;
      attributedCredits += accTotal;
      // Only one source active: a clean sample of what its credits really cost.
      const solo = accSrc.cli > 0 !== accSrc.web > 0 ? (accSrc.cli > 0 ? "cli" : "web") : null;
      if (solo) samples.push({ source: solo, points: rise, credits: accSrc[solo], at: r.at });
    }
    const unseen = rise - explained;
    if (unseen > 1e-9) {
      const claim = claims.find((c) => c.until.getTime() > since);
      if (claim) {
        dev(claim.device_id).claimed += unseen;
        claimed += unseen;
      } else {
        unobserved += unseen;
      }
    }
    acc.clear();
    accTotal = 0;
    accSrc.cli = accSrc.web = 0;
    max = r.week_pct;
    since = r.at.getTime();
  }
  take(nowMs);

  const ppc = attributedPoints >= 1 && attributedCredits > 0 ? attributedPoints / attributedCredits : fallbackPpc;
  let pending = 0;
  let observed = 0;
  for (const [id, d] of devices) {
    d.pending = round3((acc.get(id) ?? 0) * ppc);
    d.attributed = round3(d.attributed);
    d.claimed = round3(d.claimed);
    d.points = round3(d.attributed + d.pending + d.claimed);
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
    claimed: round3(claimed),
    before_clare: round3(beforeClare),
    pending: round3(pending),
    points_per_credit: ppc,
    attributed_points: round3(attributedPoints),
    attributed_credits: round6(attributedCredits),
    devices,
    samples,
  };
}

// ── Status ───────────────────────────────────────────────────

export type State = "ok" | "warn" | "over" | "blocked";

export interface Status {
  allowed: boolean;
  state: State;
  basis: "meter" | "estimate";
  meter_at: string | null; // when Claude's official meter was last read (meter basis only)
  scope: "account" | "group" | "device"; // which limit used/limit/pct describe: the one closest to running out
  used: number;
  limit: number;
  pct: number;
  account: { used: number; budget: number; pct: number };
  group: { id: string; label: string; used: number; budget: number; pct: number } | null;
  device: { id: string; label: string; used: number; budget: number | null; pct: number | null } | null;
  resets_at: string;
  enforce: boolean;
  strict_hooks: boolean;
  title: string;
  message: string;
}

export interface StatusInput {
  account: { used: number; budget: number; warn_pct: number; enforce: boolean; strict_hooks: boolean };
  group?: { id: string; label: string; used: number; budget: number } | null;
  device: { id: string; label: string; used: number; budget: number | null } | null;
  basis: "meter" | "estimate";
  meter_at?: Date | null;
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
  const group = i.group
    ? { id: i.group.id, label: i.group.label, used: round2(i.group.used), budget: i.group.budget, pct: pctOf(i.group.used, i.group.budget) }
    : null;
  // A device stops at the first of its own cap, its group's share, and the account budget.
  let scope: Status["scope"] = "account";
  let used = account.used;
  let limit = account.budget;
  let pct = account.pct;
  if (group && group.pct > pct) {
    scope = "group";
    used = group.used;
    limit = group.budget;
    pct = group.pct;
  }
  if (device && device.pct != null && device.pct > pct) {
    scope = "device";
    used = device.used;
    limit = device.budget!;
    pct = device.pct;
  }

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
  } else if (scope === "group") {
    const g = groupPhrase(group!.label);
    const G = g[0].toUpperCase() + g.slice(1);
    message = {
      ok: `${G} has used ${about}${p}% of its weekly share.`,
      warn: `Heads up: ${g} has used ${about}${p}% of its weekly share. It resets ${when}.`,
      blocked: `${G} has used all of its weekly share. It resets ${when}. You can change it in the clare dashboard.`,
      over: `${G} is over its weekly share (monitor only, nothing is blocked). It resets ${when}.`,
    }[state];
  } else {
    message = {
      ok: `${label} has used ${about}${p}% of its weekly budget.`,
      warn: `Heads up: ${label} has used ${about}${p}% of its weekly budget. It resets ${when}.`,
      blocked: `${label} has used all of its weekly budget. It resets ${when}. You can change it in the clare dashboard.`,
      over: `${label} is over its weekly budget (monitor only, nothing is blocked). It resets ${when}.`,
    }[state];
  }
  const what = scope === "group" ? "Share" : "Budget";
  const title = state === "blocked" ? `${what} used up` : state === "over" ? `Over ${what.toLowerCase()}` : `${about ? "~" : ""}${p}% used`;

  return {
    allowed: state !== "blocked",
    state,
    basis: i.basis,
    meter_at: i.basis === "meter" && i.meter_at ? i.meter_at.toISOString() : null,
    scope,
    used,
    limit,
    pct,
    account,
    group,
    device,
    resets_at: i.resets_at.toISOString(),
    enforce: i.account.enforce,
    strict_hooks: i.account.strict_hooks,
    title,
    message,
  };
}

/** "the pranav group", or "the Work group" when the name already says it's a group. */
export function groupPhrase(label: string): string {
  const name = label.trim();
  if (!name) return "the group";
  return /\bgroup$/i.test(name) ? `the ${name}` : `the ${name} group`;
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
/** Claude's meter unread this long raises an alert: long enough that a night without Claude doesn't. */
export const METER_STALE_ALERT_MS = 24 * HOUR_MS;

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
