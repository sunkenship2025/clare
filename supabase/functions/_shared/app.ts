// clare HTTP API. `createApp(...)` returns a fetch-style handler used by the Supabase edge
// function (Deno) and by scripts/dev-server.ts (Node). Contract: docs/ARCHITECTURE.md.

import type postgres from "postgres";
import {
  type Attribution,
  type CapacitySettings,
  type LearnedRates,
  type Source,
  type Plan,
  type Reading,
  type Status,
  attribute,
  calibrate,
  capacity,
  connectivity,
  credits,
  deviceKindName,
  enforcement,
  evaluate,
  fmtPct,
  learnRates,
  modelFamily,
  normalizeEvent,
  normalizeReading,
  OFFLINE_ALERT_MS,
  RATE_MIN_POINTS,
  safeZone,
  sourceWeights,
  VERSION,
} from "./core.ts";

type Sql = postgres.Sql;

export interface AppOptions {
  sql: Sql;
  setupSecret?: string;
  now?: () => Date;
}

const DAY_MS = 86_400_000;
const ENROLL_TTL_MS = 7 * DAY_MS;
const BROWSER_CODE_TTL_MS = 60 * 60_000;
const LOGIN_TTL_MS = 10 * 60_000;
const MAX_EVENTS = 500;
const CALIBRATE_EVERY_MS = 10 * 60_000;
const UNOBSERVED_ALERT_EVERY_MS = 6 * 3_600_000;
const READINGS_KEPT_MS = 21 * DAY_MS;
const PLANS = ["pro", "max5", "max20"];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-clare-tz, x-client-info, apikey",
  "access-control-max-age": "86400",
};

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const fail = (status: number, code: string, message: string) => new HttpError(status, code, message);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
  });
}

// ── Rows ─────────────────────────────────────────────────────

interface SettingsRow extends CapacitySettings {
  account_name: string;
  owner_name: string;
  budget_pct: number;
  warn_pct: number;
  enforce: boolean;
  strict_hooks: boolean;
  calibrated_at: Date | null;
  source_rates: LearnedRates | null;
  week_anchor: Date;
  meter: Record<string, unknown> | null;
  meter_at: Date | null;
  meter_device_id: string | null;
  unobserved_alerted: number;
  unobserved_alert_week: Date | null;
  last_unobserved_alert_at: Date | null;
  created_at: Date;
}

interface DeviceRow {
  id: string;
  kind: "cli" | "extension" | "web";
  label: string;
  info: Record<string, unknown>;
  machine_id: string | null;
  bye_hash: string | null;
  enroll_code_hash: string | null;
  admin: boolean;
  budget_pct: number | null;
  parent_id: string | null;
  problem: string | null;
  last_seen_at: Date | null;
  offline_alerted_at: Date | null;
  alerts_seen_id: number;
  created_at: Date;
  removed_at: Date | null;
  removed_reason: string | null;
}

interface Ctx {
  sql: Sql;
  now: Date;
  tz: string;
  settings: SettingsRow;
  attribution?: Attribution;
}

interface Authed extends Ctx {
  device: DeviceRow;
}

type AlertKind = "device_enrolled" | "device_removed" | "config_changed" | "device_offline" | "unobserved_usage";

// numeric columns arrive as strings from postgres.js
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toSettings(r: Record<string, unknown>): SettingsRow {
  return {
    ...(r as unknown as SettingsRow),
    budget_pct: Number(r.budget_pct),
    warn_pct: Number(r.warn_pct),
    capacity_manual: num(r.capacity_manual),
    capacity_calibrated: num(r.capacity_calibrated),
    unobserved_alerted: Number(r.unobserved_alerted ?? 0),
  };
}

function toDevice(r: Record<string, unknown>): DeviceRow {
  return { ...(r as unknown as DeviceRow), budget_pct: num(r.budget_pct), alerts_seen_id: Number(r.alerts_seen_id ?? 0) };
}

// ── Crypto helpers ───────────────────────────────────────────

const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function randomCode(len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function randomToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return prefix + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── Input helpers ────────────────────────────────────────────

async function body(req: Request): Promise<Record<string, unknown>> {
  if (req.method === "GET" || req.method === "DELETE") return {};
  const text = await req.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }
  throw fail(400, "bad_json", "That request didn't make sense to the server.");
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function cleanInfo(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 20)) {
    if (typeof val === "string") out[k.slice(0, 40)] = val.slice(0, 200);
    else if (typeof val === "number" || typeof val === "boolean") out[k.slice(0, 40)] = val;
  }
  return out;
}

/** A points value in (0, 100], or an error. */
function points(v: unknown, what: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 100) throw fail(400, "bad_budget", `${what} has to be between 0 and 100%.`);
  return Math.round(n * 100) / 100;
}

/** Changing settings, caps or devices needs an admin device (or a dashboard opened from one). */
function requireAdmin(ctx: Authed) {
  if (!ctx.device.admin) {
    throw fail(403, "admin_only",
      "Only an admin device can change this. Open the dashboard from an admin device, or run scripts/setup.sh login.");
  }
}

// ── Shared state ─────────────────────────────────────────────

async function loadCtx(sql: Sql, now: Date, tz: string): Promise<Ctx> {
  const [row] = await sql`select * from clare_settings where id = 1`;
  if (!row) throw fail(503, "needs_setup", "clare hasn't been set up yet.");
  return { sql, now, tz, settings: toSettings(row) };
}

/** This week's meter attribution, computed once per request. */
async function week(ctx: Ctx): Promise<Attribution> {
  if (ctx.attribution) return ctx.attribution;
  const since = new Date(ctx.now.getTime() - 8 * DAY_MS);
  const readings = await ctx.sql<{ at: Date; week_pct: number; week_resets_at: Date }[]>`
    select at, week_pct::float8 as week_pct, week_resets_at
    from clare_meter_readings where at >= ${since} order by at, id`;
  const activity = await ctx.sql<{ device_id: string | null; at: Date; credits: number; source: Source }[]>`
    select device_id, at, credits::float8 as credits, source from clare_usage where at >= ${since}`;
  ctx.attribution = attribute({
    readings: readings.map((r) => ({ at: new Date(r.at), week_pct: r.week_pct, week_resets_at: new Date(r.week_resets_at) })),
    activity: activity.map((a) => ({ device_id: a.device_id, at: new Date(a.at), credits: a.credits, source: a.source })),
    now: ctx.now,
    createdAt: new Date(ctx.settings.created_at),
    anchor: new Date(ctx.settings.week_anchor),
    capacity: capacity(ctx.settings).value,
    rates: ctx.settings.source_rates,
  });
  return ctx.attribution;
}

/**
 * A computer and the browsers that belong to it count as one device: one cap, one total.
 * A browser whose computer was removed stands on its own again.
 */
async function computerOf(ctx: Ctx, device: DeviceRow): Promise<{ root: DeviceRow; members: string[] }> {
  let root = device;
  if (device.parent_id) {
    const [p] = await ctx.sql`select * from clare_devices where id = ${device.parent_id} and removed_at is null`;
    if (p) root = toDevice(p);
  }
  const children = await ctx.sql<{ id: string }[]>`select id from clare_devices where parent_id = ${root.id}`;
  return { root, members: [root.id, ...children.map((c) => c.id)] };
}

async function statusFor(ctx: Ctx, device: DeviceRow | null): Promise<Status> {
  const w = await week(ctx);
  const s = ctx.settings;
  const metered = device && device.kind !== "web" ? await computerOf(ctx, device) : null;
  return evaluate({
    account: { used: w.used, budget: s.budget_pct, warn_pct: s.warn_pct, enforce: s.enforce, strict_hooks: s.strict_hooks },
    device: metered
      ? {
        id: metered.root.id,
        label: deviceName(metered.root),
        used: metered.members.reduce((sum, id) => sum + (w.devices.get(id)?.points ?? 0), 0),
        budget: metered.root.budget_pct,
      }
      : null,
    basis: w.basis,
    resets_at: w.week.end,
    now: ctx.now,
    tz: ctx.tz,
  });
}

// All timestamps come from the app clock (never the DB's now()) so comparisons like
// "alerts since my last heartbeat" can't be skewed by edge-vs-database clock drift.
async function alert(ctx: { sql: Sql; now: Date }, kind: AlertKind, message: string, deviceId: string | null = null) {
  await ctx.sql`insert into clare_alerts (device_id, kind, message, created_at)
                values (${deviceId}, ${kind}, ${message}, ${ctx.now})`;
}

function deviceName(d: { label: string; kind: string }): string {
  return d.label || deviceKindName(d.kind);
}

function deviceWhat(d: { label: string; kind: string }): string {
  return d.kind === "cli" ? `Claude Code on ${deviceName(d)}` : `the browser extension in ${deviceName(d)}`;
}

/** A removed device's health alerts no longer need attention. */
async function resolveDeviceAlerts(ctx: Ctx, deviceId: string) {
  await ctx.sql`update clare_alerts set resolved_at = ${ctx.now}
                where device_id = ${deviceId} and kind in ('device_offline', 'config_changed') and resolved_at is null`;
}

/** Raise a device_offline alert for devices that have gone quiet (checked lazily, no cron needed). */
async function offlineSweep(ctx: Ctx) {
  const cutoff = new Date(ctx.now.getTime() - OFFLINE_ALERT_MS);
  const quiet = (await ctx.sql`
    update clare_devices set offline_alerted_at = ${ctx.now}
    where kind <> 'web' and removed_at is null and offline_alerted_at is null and last_seen_at < ${cutoff}
    returning *`).map(toDevice);
  for (const d of quiet) {
    await alert(ctx, "device_offline", `${deviceName(d)} hasn't checked in for 2 days, so clare can't confirm its budget holds.`, d.id);
  }
}

/** Store a meter reading, then recalibrate and check for unobserved usage. */
async function storeReading(ctx: Ctx, r: Reading, deviceId: string): Promise<boolean> {
  const s = ctx.settings;
  const [same] = await ctx.sql`
    select 1 from clare_meter_readings
    where week_pct = ${r.week_pct}
      and week_resets_at between ${new Date(r.week_resets_at.getTime() - 3_600_000)} and ${new Date(r.week_resets_at.getTime() + 3_600_000)}
    limit 1`;
  if (!same) {
    await ctx.sql`insert into clare_meter_readings (device_id, at, week_pct, week_resets_at, five_pct, five_resets_at, created_at)
                  values (${deviceId}, ${r.at}, ${r.week_pct}, ${r.week_resets_at}, ${r.five_pct}, ${r.five_resets_at}, ${ctx.now})`;
    ctx.attribution = undefined;
  }
  if (!s.meter_at || r.at >= new Date(s.meter_at)) {
    const meter = {
      seven_day: { pct: r.week_pct, resets_at: r.week_resets_at.toISOString() },
      five_hour: r.five_pct === null ? null : { pct: r.five_pct, resets_at: r.five_resets_at?.toISOString() ?? null },
    };
    await ctx.sql`update clare_settings set meter = ${ctx.sql.json(meter as postgres.JSONValue)}, meter_at = ${r.at},
                    meter_device_id = ${deviceId}, week_anchor = ${r.week_resets_at} where id = 1`;
    Object.assign(s, { meter, meter_at: r.at, meter_device_id: deviceId, week_anchor: r.week_resets_at });
  }
  if (same) return false;

  const w = await week(ctx);
  // Learn from single-source rises newer than the last ones folded in.
  const since = s.source_rates?.at ? Date.parse(s.source_rates.at) : 0;
  const fresh = w.samples.filter((x) => x.at.getTime() > since);
  if (fresh.length) {
    const rates = learnRates(s.source_rates, fresh);
    await ctx.sql`update clare_settings set source_rates = ${ctx.sql.json(rates as postgres.JSONValue)} where id = 1`;
    s.source_rates = rates;
  }
  if (!s.calibrated_at || ctx.now.getTime() - new Date(s.calibrated_at).getTime() >= CALIBRATE_EVERY_MS) {
    const c = calibrate(s.capacity_calibrated, w.attributed_credits, w.attributed_points);
    if (c !== s.capacity_calibrated) {
      await ctx.sql`update clare_settings set capacity_calibrated = ${c}, calibrated_at = ${ctx.now} where id = 1`;
      s.capacity_calibrated = c;
      s.calibrated_at = ctx.now;
    }
    await ctx.sql`delete from clare_meter_readings where at < ${new Date(ctx.now.getTime() - READINGS_KEPT_MS)}`;
  }

  // Unobserved usage: alert when it grew by a point since the last alert this week, at most every 6 h.
  const sameWeek = s.unobserved_alert_week &&
    Math.abs(new Date(s.unobserved_alert_week).getTime() - w.week.end.getTime()) <= 3_600_000;
  const alerted = sameWeek ? s.unobserved_alerted : 0;
  const last = s.last_unobserved_alert_at ? new Date(s.last_unobserved_alert_at).getTime() : 0;
  if (w.basis === "meter" && w.unobserved - alerted >= 1 && ctx.now.getTime() - last >= UNOBSERVED_ALERT_EVERY_MS) {
    await ctx.sql`update clare_settings set unobserved_alerted = ${w.unobserved}, unobserved_alert_week = ${w.week.end},
                    last_unobserved_alert_at = ${ctx.now} where id = 1`;
    Object.assign(s, { unobserved_alerted: w.unobserved, unobserved_alert_week: w.week.end, last_unobserved_alert_at: ctx.now });
    await alert(ctx, "unobserved_usage",
      `About ${fmtPct(w.unobserved)} of this week's limit was used where clare couldn't see it: the phone app, another browser, claude.ai/code, or a computer without clare.`);
  }
  return true;
}

// ── Auth ─────────────────────────────────────────────────────

async function authenticate(req: Request, ctx: Ctx): Promise<Authed> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token.startsWith("clr_")) throw fail(401, "unauthorized", "This device isn't connected to clare.");
  const [row] = await ctx.sql`select * from clare_devices where token_hash = ${await sha256(token)}`;
  if (!row) throw fail(401, "unauthorized", "This device isn't connected to clare.");
  const device = toDevice(row);
  if (device.removed_at) throw fail(410, "revoked", "This device was removed from clare.");
  if (device.offline_alerted_at) {
    // Back after a long silence: the offline alert no longer applies.
    await ctx.sql`update clare_devices set offline_alerted_at = null where id = ${device.id}`;
    await ctx.sql`update clare_alerts set resolved_at = ${ctx.now}
                  where device_id = ${device.id} and kind = 'device_offline' and resolved_at is null`;
    device.offline_alerted_at = null;
  }
  if (!device.last_seen_at || ctx.now.getTime() - new Date(device.last_seen_at).getTime() > 30_000) {
    await ctx.sql`update clare_devices set last_seen_at = ${ctx.now} where id = ${device.id}`;
    device.last_seen_at = ctx.now;
  }
  return { ...ctx, device };
}

// ── Handlers: public ─────────────────────────────────────────

async function health(sql: Sql) {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from clare_settings`;
  return { ok: true, needs_setup: n === 0, version: VERSION };
}

async function setup(sql: Sql, now: Date, secret: string | undefined, b: Record<string, unknown>) {
  if (!secret) throw fail(503, "setup_disabled", "Setup is turned off on this server.");
  if (!timingSafeEqual(str(b.secret, 200), secret)) throw fail(403, "forbidden", "That setup secret is wrong.");
  const ownerName = str(b.owner_name, 60);
  const accountName = str(b.account_name, 60) || "My Claude";
  const plan = (PLANS.includes(String(b.plan)) ? b.plan : "max5") as Plan;
  const code = randomCode(16);
  await sql.begin(async (tx) => {
    await tx`lock table clare_settings in exclusive mode`;
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from clare_settings`;
    if (n > 0) throw fail(409, "already_setup", "clare is already set up.");
    await tx`insert into clare_settings (id, account_name, owner_name, plan, week_anchor, created_at)
             values (1, ${accountName}, ${ownerName}, ${plan}, ${now}, ${now})`;
    await tx`insert into clare_login_codes (code_hash, admin, expires_at)
             values (${await sha256(code)}, true, ${new Date(now.getTime() + LOGIN_TTL_MS)})`;
  });
  return { login_code: code };
}

/** Lost the dashboard link? Mint a new one with the setup secret. */
async function recover(ctx: Ctx, secret: string | undefined, b: Record<string, unknown>) {
  if (!secret) throw fail(503, "setup_disabled", "Setup is turned off on this server.");
  if (!timingSafeEqual(str(b.secret, 200), secret)) throw fail(403, "forbidden", "That setup secret is wrong.");
  const code = randomCode(16);
  await ctx.sql`insert into clare_login_codes (code_hash, admin, expires_at)
                values (${await sha256(code)}, true, ${new Date(ctx.now.getTime() + LOGIN_TTL_MS)})`;
  return { login_code: code };
}

async function findEnrollCode(ctx: Ctx, code: string) {
  const hash = await sha256(code.trim().toLowerCase());
  const [row] = await ctx.sql<
    { code_hash: string; admin: boolean; kind: "cli" | "extension" | null; parent_id: string | null; expires_at: Date }[]
  >`select code_hash, admin, kind, parent_id, expires_at from clare_enroll_codes where code_hash = ${hash}`;
  if (!row) throw fail(404, "invalid_code", "This link isn't valid. Make a new one in the clare dashboard (Add a device).");
  return { hash, admin: row.admin, kind: row.kind, parent_id: row.parent_id, expired: new Date(row.expires_at) <= ctx.now };
}

async function enrollInfo(ctx: Ctx, code: string) {
  const c = await findEnrollCode(ctx, code);
  const devices = (await ctx.sql`
    select * from clare_devices
    where enroll_code_hash = ${c.hash} and kind <> 'web' and removed_at is null order by created_at`).map(toDevice);
  return {
    account_name: ctx.settings.account_name,
    owner_name: ctx.settings.owner_name,
    admin: c.admin,
    kind: c.kind,
    expired: c.expired,
    devices: devices.map((d) => ({ kind: d.kind, label: deviceName(d), created_at: d.created_at, last_seen_at: d.last_seen_at })),
  };
}

async function enroll(ctx: Ctx, b: Record<string, unknown>) {
  const kind = b.kind === "cli" || b.kind === "extension" ? b.kind : null;
  if (!kind) throw fail(400, "bad_kind", "Unknown device type.");
  const c = await findEnrollCode(ctx, str(b.code, 40));
  if (c.expired) throw fail(410, "expired_code", "This link has expired. Make a new one in the clare dashboard (Add a device).");
  if (c.kind && c.kind !== kind) {
    throw fail(403, "wrong_kind", c.kind === "extension" ? "This link only adds a browser." : "This link only adds a computer.");
  }
  const info = cleanInfo(b.info);
  const machineId = str(info.machine_id, 200) || null;
  const label = str(b.label, 80) || deviceKindName(kind);
  const token = randomToken("clr_");
  const bye = randomToken("bye_");

  const { id, replaced } = await ctx.sql.begin(async (tx) => {
    // Re-enrolling the same machine replaces its old device and keeps its history and cap.
    const old = machineId
      ? (await tx`update clare_devices set removed_at = ${ctx.now}, removed_reason = 'replaced'
                  where kind = ${kind} and machine_id = ${machineId} and removed_at is null
                  returning *`).map(toDevice)
      : [];
    const cap = old.find((d) => d.budget_pct != null)?.budget_pct ?? null;
    const admin = c.admin || old.some((d) => d.admin);
    // A browser added from a computer belongs to it (or keeps the computer it had).
    let parent: string | null = null;
    if (kind === "extension") {
      for (const candidate of [c.parent_id, ...old.map((o) => o.parent_id)]) {
        if (!candidate) continue;
        const [p] = await tx`select id from clare_devices where id = ${candidate} and kind = 'cli' and removed_at is null`;
        if (p) {
          parent = candidate;
          break;
        }
      }
    }
    const [d] = await tx<{ id: string }[]>`
      insert into clare_devices (kind, label, info, machine_id, token_hash, bye_hash, enroll_code_hash, admin, budget_pct,
                                 parent_id, last_seen_at, created_at, alerts_seen_id)
      values (${kind}, ${label}, ${tx.json(info as postgres.JSONValue)}, ${machineId}, ${await sha256(token)},
              ${await sha256(bye)}, ${c.hash}, ${admin}, ${cap}, ${parent}, ${ctx.now}, ${ctx.now},
              (select coalesce(max(id), 0) from clare_alerts))
      returning id`;
    if (old.length) {
      const ids = old.map((o) => o.id);
      await tx`update clare_usage set device_id = ${d.id} where device_id = any(${ids}::uuid[])`;
      await tx`update clare_meter_readings set device_id = ${d.id} where device_id = any(${ids}::uuid[])`;
    }
    if (kind === "cli" && machineId) {
      // Reinstalled on the same computer: its browsers belong to it again.
      await tx`update clare_devices set parent_id = ${d.id}
               where parent_id in (select id from clare_devices where kind = 'cli' and machine_id = ${machineId} and id <> ${d.id})`;
    }
    return { id: d.id, replaced: old.length > 0 };
  });
  const [row] = await ctx.sql`select * from clare_devices where id = ${id}`;
  const device = toDevice(row);
  if (!replaced) {
    const what = deviceWhat(device);
    await alert(ctx, "device_enrolled", `${what[0].toUpperCase()}${what.slice(1)} is now connected.`, id);
  }
  return { token, device_id: id, bye_secret: bye, status: await statusFor(ctx, device) };
}

async function login(ctx: Ctx, req: Request, b: Record<string, unknown>) {
  const hash = await sha256(str(b.code, 64));
  const [row] = await ctx.sql<{ admin: boolean }[]>`
    update clare_login_codes set used_at = ${ctx.now}
    where code_hash = ${hash} and used_at is null and expires_at > ${ctx.now}
    returning admin`;
  if (!row) throw fail(401, "bad_login", "That sign-in link has expired. Run `clare dashboard` or use Open dashboard in the extension.");
  const token = randomToken("clr_");
  const ua = req.headers.get("user-agent") ?? "";
  const label = /Mobile|Android|iPhone/i.test(ua) ? "Dashboard (phone)" : "Dashboard";
  await ctx.sql`insert into clare_devices (kind, label, admin, token_hash, last_seen_at, created_at, alerts_seen_id)
                values ('web', ${label}, ${row.admin}, ${await sha256(token)}, ${ctx.now}, ${ctx.now},
                        (select coalesce(max(id), 0) from clare_alerts))`;
  return { token, admin: row.admin };
}

async function bye(ctx: Ctx, b: Record<string, unknown>) {
  const id = str(b.device_id, 40);
  const secret = str(b.secret, 100);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !secret) throw fail(400, "bad_request", "Missing details.");
  const [row] = await ctx.sql`select * from clare_devices where id = ${id}`;
  const d = row ? toDevice(row) : null;
  if (!d || !d.bye_hash || !timingSafeEqual(d.bye_hash, await sha256(secret))) {
    throw fail(403, "forbidden", "Unknown device.");
  }
  if (!d.removed_at) {
    await ctx.sql`update clare_devices set removed_at = ${ctx.now}, removed_reason = 'uninstalled' where id = ${d.id}`;
    await resolveDeviceAlerts(ctx, d.id);
    await alert(ctx, "device_removed", `The clare extension was removed from ${deviceName(d)}.`, d.id);
  }
  return { ok: true };
}

// ── Handlers: device ─────────────────────────────────────────

async function report(ctx: Authed, b: Record<string, unknown>) {
  if (ctx.device.kind === "web") throw fail(403, "forbidden", "Dashboards can't report usage.");
  const raw = Array.isArray(b.events) ? b.events.slice(0, MAX_EVENTS) : [];
  const source = ctx.device.kind === "extension" ? "web" : "cli";
  const seen = new Set<string>();
  const rows = [];
  for (const r of raw) {
    const e = normalizeEvent(r, ctx.now);
    if (!e || seen.has(e.key)) continue;
    seen.add(e.key);
    rows.push({
      device_id: ctx.device.id,
      source,
      key: e.key,
      model: e.model,
      input: e.input,
      output: e.output,
      cache_read: e.cache_read,
      cache_write: e.cache_write,
      cache_write_1h: e.cache_write_1h,
      credits: credits(e),
      estimated: e.estimated,
      at: e.at,
      created_at: ctx.now,
    });
  }
  if (rows.length) {
    // Same key reported twice (retries, re-scans, two devices reading one transcript): keep the
    // larger numbers, never double count.
    await ctx.sql`
      insert into clare_usage ${ctx.sql(rows)}
      on conflict (key) do update set
        input = greatest(clare_usage.input, excluded.input),
        output = greatest(clare_usage.output, excluded.output),
        cache_read = greatest(clare_usage.cache_read, excluded.cache_read),
        cache_write = greatest(clare_usage.cache_write, excluded.cache_write),
        cache_write_1h = greatest(clare_usage.cache_write_1h, excluded.cache_write_1h),
        credits = greatest(clare_usage.credits, excluded.credits)`;
  }
  const reading = b.meter ? normalizeReading(b.meter, ctx.now) : null;
  if (reading) await storeReading(ctx, reading, ctx.device.id);
  return { accepted: rows.length, status: await statusFor(ctx, ctx.device) };
}

async function meter(ctx: Authed, b: Record<string, unknown>) {
  if (ctx.device.kind === "web") throw fail(403, "forbidden", "Dashboards can't report usage.");
  if (!b.seven_day || typeof b.seven_day !== "object") throw fail(400, "bad_meter", "Couldn't read that usage meter.");
  const reading = normalizeReading(b, ctx.now);
  const stored = reading ? await storeReading(ctx, reading, ctx.device.id) : false;
  return { ok: true, stored };
}

async function heartbeat(ctx: Authed, b: Record<string, unknown>) {
  const info = cleanInfo(b.info);
  const h = (b.health && typeof b.health === "object" ? b.health : {}) as Record<string, unknown>;
  const problems = Array.isArray(h.problems) ? h.problems.filter((p) => typeof p === "string").slice(0, 5) : [];
  const problem = h.ok === false ? (problems.join("; ") || "something changed").slice(0, 300) : null;

  await ctx.sql`update clare_devices
                set info = info || ${ctx.sql.json(info as postgres.JSONValue)}, problem = ${problem}
                where id = ${ctx.device.id}`;
  if (problem && !ctx.device.problem) {
    await alert(ctx, "config_changed",
      `clare's files on ${deviceName(ctx.device)} were changed (${problem}). It restored what it could.`, ctx.device.id);
  }
  await offlineSweep(ctx);

  // New alerts for notifications, except ones about this device. Cursor by alert id: snapshot the
  // max first so nothing inserted meanwhile is skipped.
  const [{ top }] = await ctx.sql<{ top: number }[]>`select coalesce(max(id), 0)::int8 as top from clare_alerts`;
  const alerts = await ctx.sql<{ id: number; kind: string; message: string; created_at: Date }[]>`
    select id, kind, message, created_at from clare_alerts
    where resolved_at is null and id > ${ctx.device.alerts_seen_id} and id <= ${top}
      and (device_id is null or device_id <> ${ctx.device.id})
    order by id limit 20`;
  await ctx.sql`update clare_devices set alerts_seen_id = greatest(alerts_seen_id, ${top}) where id = ${ctx.device.id}`;

  return {
    status: await statusFor(ctx, ctx.device),
    settings: { enforce: ctx.settings.enforce, strict_hooks: ctx.settings.strict_hooks },
    alerts: alerts.map((a) => ({ ...a, id: Number(a.id) })),
  };
}

async function removeSelf(ctx: Authed, b: Record<string, unknown>) {
  const reason = str(b.reason, 60) || "uninstalled";
  await ctx.sql`update clare_devices set removed_at = ${ctx.now}, removed_reason = ${reason} where id = ${ctx.device.id}`;
  await resolveDeviceAlerts(ctx, ctx.device.id);
  if (ctx.device.kind !== "web") {
    const message = ctx.device.kind === "cli"
      ? `clare was removed from ${deviceName(ctx.device)} (Claude Code).`
      : `The clare extension was removed from ${deviceName(ctx.device)}.`;
    await alert(ctx, "device_removed", message, ctx.device.id);
  }
  return { ok: true };
}

async function loginLink(ctx: Authed) {
  const code = randomCode(16);
  const expires = new Date(ctx.now.getTime() + LOGIN_TTL_MS);
  // The dashboard gets the same rights as the device that opened it.
  await ctx.sql`insert into clare_login_codes (code_hash, admin, expires_at)
                values (${await sha256(code)}, ${ctx.device.admin}, ${expires})`;
  return { code, expires_at: expires };
}

async function enrollCode(ctx: Authed, b: Record<string, unknown>) {
  const kind = b.kind === "cli" || b.kind === "extension" ? b.kind : null;
  // Any device may add a browser (a one-hour, browser-only code, e.g. for `clare browser`), and the
  // browser gets the same admin rights as the device that asked. Adding computers takes an admin.
  if (kind !== "extension") requireAdmin(ctx);
  const admin = b.admin === true && ctx.device.admin;
  const code = randomCode(10);
  const expires = new Date(ctx.now.getTime() + (kind === "extension" ? BROWSER_CODE_TTL_MS : ENROLL_TTL_MS));
  await ctx.sql`delete from clare_enroll_codes where expires_at < ${new Date(ctx.now.getTime() - 30 * DAY_MS)}`;
  const parent = kind === "extension" && ctx.device.kind === "cli" ? ctx.device.id : null;
  await ctx.sql`insert into clare_enroll_codes (code_hash, admin, kind, parent_id, created_at, expires_at)
                values (${await sha256(code)}, ${admin}, ${kind}, ${parent}, ${ctx.now}, ${expires})`;
  return { code, admin, kind, expires_at: expires };
}

async function me(ctx: Authed) {
  await offlineSweep(ctx);
  const w = await week(ctx);
  const s = ctx.settings;

  const devices = (await ctx.sql`
    select * from clare_devices
    where kind <> 'web' and coalesce(removed_reason, '') <> 'replaced'
      and (removed_at is null or removed_at > ${new Date(ctx.now.getTime() - 14 * DAY_MS)})
    order by removed_at is not null, created_at`).map(toDevice);
  const usage = await ctx.sql<{ device_id: string | null; model: string; credits: number }[]>`
    select device_id, model, sum(credits)::float8 as credits
    from clare_usage where at >= ${w.week.start} group by device_id, model`;
  const alerts = await ctx.sql<{ id: number; kind: string; message: string; created_at: Date; device_id: string | null }[]>`
    select id, kind, message, created_at, device_id from clare_alerts
    where resolved_at is null order by created_at desc, id desc limit 50`;
  const daily = await ctx.sql<{ date: string; device_id: string | null; credits: number }[]>`
    select to_char(date_trunc('day', at at time zone ${ctx.tz}), 'YYYY-MM-DD') as date, device_id,
           sum(credits)::float8 as credits
    from clare_usage
    where at >= ${new Date(ctx.now.getTime() - 14 * DAY_MS)}
    group by 1, 2 order by 1`;
  const labels = new Map<string, string>();
  for (const r of await ctx.sql<{ id: string; kind: string; label: string }[]>`
    select id, kind, label from clare_devices where kind <> 'web'`) labels.set(r.id, deviceName(r));

  const meterAt = s.meter_at ? new Date(s.meter_at) : null;
  return {
    me: { device_id: ctx.device.id, kind: ctx.device.kind, admin: ctx.device.admin },
    account: {
      name: s.account_name,
      owner_name: s.owner_name,
      plan: s.plan,
      budget_pct: s.budget_pct,
      warn_pct: s.warn_pct,
      enforce: s.enforce,
      strict_hooks: s.strict_hooks,
      basis: w.basis,
      capacity: capacity(s),
      week: { start: w.week.start, resets_at: w.week.end },
      // Only this week's reading; an older one would describe a week that has already reset.
      meter: s.meter && w.basis === "meter" && meterAt && meterAt >= w.week.start
        ? { ...s.meter, at: meterAt, device_label: s.meter_device_id ? labels.get(s.meter_device_id) ?? null : null }
        : null,
      used: w.used,
      observed: w.observed,
      unobserved: w.unobserved,
      before_clare: w.before_clare,
      pending: w.pending,
      // How clare weighs claude.ai's estimated tokens against Claude Code's exact ones.
      estimation: {
        browser_weight: sourceWeights(s.source_rates).web,
        learned: {
          cli: Math.round((s.source_rates?.cli?.points ?? 0) * 10) / 10,
          web: Math.round((s.source_rates?.web?.points ?? 0) * 10) / 10,
        },
        min_points: RATE_MIN_POINTS,
      },
    },
    status: await statusFor(ctx, ctx.device),
    devices: devices.map((d) => {
      const conn = connectivity(d, ctx.now);
      const mine = usage.filter((u) => u.device_id === d.id);
      const byModel: Record<string, number> = {};
      for (const u of mine) byModel[modelFamily(u.model)] = round4((byModel[modelFamily(u.model)] ?? 0) + u.credits);
      return {
        id: d.id,
        kind: d.kind,
        label: deviceName(d),
        os: typeof d.info.os === "string" ? d.info.os : null,
        browser: typeof d.info.browser === "string" ? d.info.browser : null,
        connectivity: conn,
        enforcement: enforcement(conn),
        problem: d.problem,
        last_seen_at: d.last_seen_at,
        created_at: d.created_at,
        removed_at: d.removed_at,
        admin: d.admin,
        budget_pct: d.budget_pct,
        parent_id: d.parent_id,
        usage: {
          points: w.devices.get(d.id)?.points ?? 0,
          credits: round4(mine.reduce((sum, u) => sum + u.credits, 0)),
          by_model: byModel,
        },
      };
    }),
    alerts: alerts.map((a) => ({
      id: Number(a.id),
      kind: a.kind,
      message: a.message,
      created_at: a.created_at,
      device_id: a.device_id,
      device_label: a.device_id ? labels.get(a.device_id) ?? null : null,
    })),
    daily: daily.map((d) => ({ date: d.date, device_id: d.device_id, credits: round4(d.credits) })),
  };
}

// Small web messages cost fractions of a cent; keep enough precision that they don't read as 0.
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

async function patchDevice(ctx: Authed, id: string, b: Record<string, unknown>) {
  requireAdmin(ctx);
  const [row] = await ctx.sql`select * from clare_devices where id = ${id} and kind <> 'web'`;
  if (!row) throw fail(404, "not_found", "That device is gone.");
  const d = toDevice(row);
  const label = b.label === undefined ? d.label : str(b.label, 80);
  if (!label) throw fail(400, "bad_label", "A device name can't be empty.");
  const cap = b.budget_pct === undefined ? d.budget_pct : b.budget_pct === null ? null : points(b.budget_pct, "A device budget");
  const admin = typeof b.admin === "boolean" ? b.admin : d.admin;
  let parent = d.parent_id;
  if (b.parent_id !== undefined) {
    parent = b.parent_id === null ? null : str(b.parent_id, 40);
    if (parent) {
      const [p] = await ctx.sql`select id from clare_devices where id = ${parent} and kind = 'cli' and removed_at is null`;
      if (d.kind !== "extension" || !p) throw fail(400, "bad_parent", "Only a browser can belong to a computer with Claude Code.");
    }
  }
  await ctx.sql`update clare_devices set label = ${label}, budget_pct = ${cap}, admin = ${admin}, parent_id = ${parent}
                where id = ${d.id}`;
  return { ok: true };
}

async function removeDevice(ctx: Authed, id: string) {
  requireAdmin(ctx);
  const [d] = await ctx.sql<{ id: string }[]>`select id from clare_devices where id = ${id}`;
  if (!d) throw fail(404, "not_found", "That device is gone.");
  // Removing a computer removes the browsers that belong to it.
  const gone = await ctx.sql<{ id: string }[]>`
    update clare_devices set removed_at = coalesce(removed_at, ${ctx.now}),
           removed_reason = coalesce(removed_reason, 'removed from dashboard')
    where id = ${d.id} or (parent_id = ${d.id} and removed_at is null) returning id`;
  for (const g of gone) await resolveDeviceAlerts(ctx, g.id);
  return { ok: true };
}

async function resolveAlert(ctx: Authed, id: string) {
  requireAdmin(ctx);
  const [a] = await ctx.sql<{ id: number }[]>`select id from clare_alerts where id = ${Number(id) || 0}`;
  if (!a) throw fail(404, "not_found", "That alert is gone.");
  await ctx.sql`update clare_alerts set resolved_at = ${ctx.now} where id = ${a.id}`;
  return { ok: true };
}

async function patchSettings(ctx: Authed, b: Record<string, unknown>) {
  requireAdmin(ctx);
  const s = ctx.settings;
  const accountName = b.account_name === undefined ? s.account_name : str(b.account_name, 60) || s.account_name;
  const ownerName = b.owner_name === undefined ? s.owner_name : str(b.owner_name, 60);
  const plan = b.plan === undefined ? s.plan : PLANS.includes(String(b.plan)) ? b.plan as Plan : null;
  if (!plan) throw fail(400, "bad_plan", "Unknown plan.");
  let manual = s.capacity_manual;
  if (b.capacity_manual !== undefined) {
    manual = b.capacity_manual === null ? null : Number(b.capacity_manual);
    if (manual !== null && !(manual > 0)) throw fail(400, "bad_capacity", "Capacity has to be above 0.");
  }
  const budget = b.budget_pct === undefined ? s.budget_pct : points(b.budget_pct, "The weekly budget");
  let warn = s.warn_pct;
  if (b.warn_pct !== undefined) {
    warn = Number(b.warn_pct);
    if (!Number.isFinite(warn) || warn < 10 || warn >= 100) throw fail(400, "bad_warn", "Warn between 10% and 99% of the budget.");
  }
  const enforce = typeof b.enforce === "boolean" ? b.enforce : s.enforce;
  const strict = typeof b.strict_hooks === "boolean" ? b.strict_hooks : s.strict_hooks;
  await ctx.sql`update clare_settings set account_name = ${accountName}, owner_name = ${ownerName}, plan = ${plan},
                  capacity_manual = ${manual}, budget_pct = ${budget}, warn_pct = ${warn}, enforce = ${enforce},
                  strict_hooks = ${strict}
                where id = 1`;
  return { ok: true };
}

// ── Router ───────────────────────────────────────────────────

function routeOf(url: URL): string {
  // Supabase passes "/api/<route>" (or "/functions/v1/api/<route>"); the dev server passes "/<route>".
  const p = url.pathname.replace(/^\/functions\/v1/, "").replace(/^\/api(?=\/|$)/, "");
  return p.replace(/\/+$/, "") || "/";
}

export function createApp(opts: AppOptions) {
  const clock = opts.now ?? (() => new Date());

  return async function handle(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    const route = routeOf(url);
    const method = req.method;
    const now = clock();
    const tz = safeZone(req.headers.get("x-clare-tz"));
    const sql = opts.sql;

    try {
      if (method === "GET" && route === "/health") return json(200, await health(sql));
      if (method === "POST" && route === "/setup") return json(200, await setup(sql, now, opts.setupSecret, await body(req)));

      const ctx = await loadCtx(sql, now, tz);
      let m: RegExpMatchArray | null;

      if (method === "GET" && (m = route.match(/^\/enroll\/([a-z0-9]{6,40})$/i))) return json(200, await enrollInfo(ctx, m[1]));
      if (method === "POST" && route === "/enroll") return json(200, await enroll(ctx, await body(req)));
      if (method === "POST" && route === "/login") return json(200, await login(ctx, req, await body(req)));
      if (method === "POST" && route === "/bye") return json(200, await bye(ctx, await body(req)));
      if (method === "POST" && route === "/recover") return json(200, await recover(ctx, opts.setupSecret, await body(req)));

      const a = await authenticate(req, ctx);
      const b = await body(req);
      if (method === "POST" && route === "/check") return json(200, { status: await statusFor(a, a.device) });
      if (method === "POST" && route === "/report") return json(200, await report(a, b));
      if (method === "POST" && route === "/meter") return json(200, await meter(a, b));
      if (method === "POST" && route === "/heartbeat") return json(200, await heartbeat(a, b));
      if (method === "POST" && route === "/device/remove") return json(200, await removeSelf(a, b));
      if (method === "POST" && route === "/login-link") return json(200, await loginLink(a));
      if (method === "POST" && route === "/enroll-code") return json(200, await enrollCode(a, b));
      if (method === "GET" && route === "/me") return json(200, await me(a));
      if (method === "PATCH" && route === "/settings") return json(200, await patchSettings(a, b));

      const uuid = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
      if ((m = route.match(new RegExp(`^/devices/${uuid}$`)))) {
        if (method === "PATCH") return json(200, await patchDevice(a, m[1], b));
        if (method === "DELETE") return json(200, await removeDevice(a, m[1]));
      }
      if (method === "POST" && (m = route.match(/^\/alerts\/(\d+)\/resolve$/))) return json(200, await resolveAlert(a, m[1]));

      return json(404, { error: "not_found", message: "Unknown endpoint." });
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.code, message: err.message });
      console.error(`[clare] ${method} ${route}:`, err);
      return json(500, { error: "server_error", message: "Something went wrong on the clare server. Try again in a minute." });
    }
  };
}
