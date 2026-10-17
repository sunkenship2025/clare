// Mock API for local UI work: open any page with ?api=mock (remembered; ?api=default resets).
// Shapes follow docs/ARCHITECTURE.md. State lives in memory and resets on reload.
//
// Enrollment codes: #demo (devices enroll after a few seconds), #demo-waiting, #demo-done,
//                   #demo-expired. Anything else → 404.
// Dashboard:        dash.html?api=mock#login=anything   (add &empty=1 for no devices,
//                   &estimate=1 for the estimate basis, &nogroups=1 for no groups)

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = () => Date.now();
const ago = (ms) => new Date(now() - ms).toISOString();
const later = (ms) => new Date(now() + ms).toISOString();
const params = new URLSearchParams(location.search);

function nextMonday930() {
  const d = new Date();
  d.setHours(21, 30, 0, 0);
  const add = (8 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + add);
  return d.toISOString();
}

const RESETS = nextMonday930();
const ESTIMATE = params.has("estimate");
const VIEW_ONLY = params.has("viewonly");
const GROUPS = !params.has("nogroups") && !params.has("empty");

const db = {
  account: {
    name: "My Claude",
    owner_name: "Alex",
    plan: "max5",
    budget_pct: 100,
    warn_pct: 80,
    enforce: true,
    strict_hooks: false,
    capacity_manual: null,
    capacity_calibrated: 312,
    before_clare: 6,
    unobserved: 3.4,
    pending: 0.6,
  },
  meter: ESTIMATE
    ? null
    : { seven_day: { pct: 47, resets_at: RESETS }, five_hour: { pct: 18, resets_at: later(3 * HOUR) }, at: ago(6 * MIN), device_label: "Pranav's MacBook Air" },
  // Groups of computers that share part of the weekly limit (computers point at them with group_id).
  groups: GROUPS
    ? [
        { id: "g1", label: "pranav", budget_pct: 50, created_at: ago(9 * DAY) },
        { id: "g2", label: "joy", budget_pct: 50, created_at: ago(9 * DAY) },
      ]
    : [],
  devices: params.has("empty")
    ? []
    : [
        { id: "d1", kind: "cli", label: "Pranav's MacBook Air", admin: true, os: "macOS", browser: null, created_at: ago(20 * DAY), last_seen_at: ago(2 * MIN), budget_pct: null, group_id: GROUPS ? "g1" : null, points: 24.1, credits: 76.2, by_model: { opus: 61.0, sonnet: 15.2 } },
        { id: "d2", kind: "extension", parent_id: "d1", label: "Chrome on Pranav's MacBook Air", os: "macOS", browser: "Chrome", created_at: ago(20 * DAY), last_seen_at: ago(1 * MIN), budget_pct: null, points: 6.3, credits: 19.4, by_model: { opus: 12.0, sonnet: 7.4 } },
        { id: "d3", kind: "cli", label: "joy's Claude Code", os: "Windows", browser: null, created_at: ago(12 * DAY), last_seen_at: ago(3 * MIN), budget_pct: null, group_id: GROUPS ? "g2" : null, points: 8.1, credits: 25.8, by_model: { sonnet: 22.1, haiku: 3.7 } },
        { id: "d4", kind: "cli", label: "Mac mini", os: "macOS", browser: null, created_at: ago(6 * DAY), last_seen_at: ago(4 * MIN), budget_pct: null, points: 0.3, credits: 1.1, by_model: { sonnet: 1.1 }, problem: "hook settings missing" },
        { id: "d5", kind: "cli", label: "Old iMac", os: "macOS", browser: null, created_at: ago(40 * DAY), last_seen_at: ago(50 * HOUR), removed_at: ago(48 * HOUR), budget_pct: null, points: 0, credits: 0, by_model: {} },
      ],
  alerts: params.has("empty")
    ? []
    : [
        { id: 3, kind: "config_changed", device_id: "d4", message: "clare's files on Mac mini were changed (hook settings missing). It restored what it could.", created_at: ago(40 * MIN) },
        { id: 1, kind: "unobserved_usage", device_id: null, message: "About 3% of this week's limit was used where clare couldn't see it: the phone app, another browser, claude.ai/code, or a computer without clare.", created_at: ago(20 * HOUR) },
      ],
  codes: new Map(), // code -> { mode, started, devices, expires_at }
  seq: 10,
};

db.codes.set("demo", { mode: "progressive", started: null, devices: [] });
db.codes.set("demo-waiting", { mode: "waiting", devices: [] });
db.codes.set("demo-done", {
  mode: "fixed",
  devices: [
    { kind: "cli", label: "Mac mini", created_at: ago(3 * MIN), last_seen_at: ago(1 * MIN) },
    { kind: "extension", label: "Chrome on Mac mini", created_at: ago(1 * MIN), last_seen_at: ago(1 * MIN) },
  ],
});
db.codes.set("demo-expired", { mode: "expired", devices: [] });

// 14 days of synthetic activity per device (credits/day).
const DAILY_SHAPE = {
  d1: [6, 9, 7, 0, 2, 11, 13, 8, 10, 12, 4, 0, 14, 12],
  d2: [2, 1, 3, 2, 4, 2, 3, 1, 2, 4, 3, 1, 3, 2],
  d3: [0, 0, 5, 6, 4, 3, 0, 0, 6, 5, 4, 3, 0, 0],
  d4: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0],
};

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daily() {
  const out = [];
  for (const dev of db.devices) {
    const shape = DAILY_SHAPE[dev.id];
    if (!shape) continue;
    shape.forEach((v, i) => {
      if (!v) return;
      const d = new Date();
      d.setDate(d.getDate() - (13 - i));
      out.push({ date: isoDate(d), device_id: dev.id, credits: v });
    });
  }
  return out;
}

function fmtWhen(iso) {
  const d = new Date(iso);
  return `on ${d.toLocaleDateString(undefined, { weekday: "long" })} at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function connectivity(d) {
  if (d.removed_at) return "removed";
  if (d.problem) return "problem";
  return now() - new Date(d.last_seen_at).getTime() < 12 * MIN ? "online" : "offline";
}

function enforcement(d) {
  const c = connectivity(d);
  return c === "removed" ? "removed" : c === "online" ? "active" : "unverified";
}

function capacity() {
  const a = db.account;
  if (a.capacity_manual) return { value: a.capacity_manual, source: "manual" };
  return { value: a.capacity_calibrated, source: "calibrated" };
}

function accountUsed() {
  const a = db.account;
  const observed = db.devices.reduce((s, d) => s + d.points, 0);
  if (ESTIMATE) return { used: observed, observed, unobserved: 0, before_clare: 0, pending: 0 };
  return { used: a.before_clare + observed + a.unobserved, observed, unobserved: a.unobserved, before_clare: a.before_clare, pending: a.pending };
}

const round1 = (n) => Math.round(n * 10) / 10;

/** Status for a dashboard session (account scope, device null). */
function status() {
  const a = db.account;
  const { used } = accountUsed();
  const pct = round1((used / a.budget_pct) * 100);
  const state = pct >= 100 ? (a.enforce ? "blocked" : "over") : pct >= a.warn_pct ? "warn" : "ok";
  const when = fmtWhen(RESETS);
  const ab = ESTIMATE ? "about " : "";
  const messages = {
    ok: `You've used ${ab}${Math.floor(pct)}% of this week's Claude budget.`,
    warn: `Heads up: you've used ${ab}${Math.floor(pct)}% of this week's Claude budget. It resets ${when}.`,
    blocked: `You've used all of this week's Claude budget. It resets ${when}. You can change the budget in the clare dashboard.`,
    over: `You're over this week's Claude budget (monitor only, nothing is blocked). It resets ${when}.`,
  };
  return {
    allowed: state !== "blocked",
    state,
    basis: ESTIMATE ? "estimate" : "meter",
    scope: "account",
    used: round1(used),
    limit: a.budget_pct,
    pct,
    account: { used: round1(used), budget: a.budget_pct, pct },
    device: null,
    resets_at: RESETS,
    enforce: a.enforce,
    strict_hooks: a.strict_hooks,
    title: state === "blocked" ? "Budget used up" : state === "over" ? "Over budget" : `${Math.floor(pct)}% used`,
    message: messages[state],
  };
}

function me() {
  const a = db.account;
  const totals = accountUsed();
  return {
    // ?viewonly in the page URL previews a non-admin dashboard.
    me: { device_id: "web", kind: "web", admin: !VIEW_ONLY },
    account: {
      name: a.name,
      owner_name: a.owner_name,
      plan: a.plan,
      budget_pct: a.budget_pct,
      warn_pct: a.warn_pct,
      enforce: a.enforce,
      strict_hooks: a.strict_hooks,
      basis: ESTIMATE ? "estimate" : "meter",
      capacity: capacity(),
      week: { start: new Date(new Date(RESETS).getTime() - 7 * DAY).toISOString(), resets_at: RESETS },
      meter: db.meter,
      used: round1(totals.used),
      observed: round1(totals.observed),
      unobserved: totals.unobserved,
      before_clare: totals.before_clare,
      pending: totals.pending,
      estimation: { browser_weight: 1.6, learned: { cli: 14.2, web: 4.1 }, min_points: 3 },
    },
    status: status(),
    groups: db.groups.map((g) => ({ ...g })),
    devices: db.devices.map((d) => ({
      id: d.id,
      kind: d.kind,
      label: d.label,
      os: d.os,
      browser: d.browser,
      connectivity: connectivity(d),
      enforcement: enforcement(d),
      problem: d.problem || null,
      last_seen_at: d.last_seen_at,
      created_at: d.created_at,
      removed_at: d.removed_at || null,
      admin: !!d.admin,
      budget_pct: d.budget_pct,
      parent_id: d.parent_id || null,
      group_id: d.group_id || null,
      usage: { points: d.points, credits: d.credits, by_model: d.by_model },
    })),
    alerts: db.alerts.filter((x) => !x.resolved_at).map((x) => ({
      ...x,
      device_label: db.devices.find((d) => d.id === x.device_id)?.label || null,
    })),
    daily: daily(),
  };
}

function enrollInfo(code) {
  const c = db.codes.get(code);
  if (!c) return null;
  if (c.mode === "progressive") {
    if (!c.started) c.started = now();
    const t = now() - c.started;
    c.devices = [];
    if (t > 9000) c.devices.push({ kind: "cli", label: "Mac mini", created_at: ago(t - 9000), last_seen_at: ago(0) });
    if (t > 18000) c.devices.push({ kind: "extension", label: "Chrome on Mac mini", created_at: ago(t - 18000), last_seen_at: ago(0) });
  }
  return {
    account_name: db.account.name,
    owner_name: db.account.owner_name,
    expired: c.mode === "expired",
    devices: c.devices,
  };
}

const ok = (data) => ({ status: 200, data });
const err = (status, error, message) => ({ status, data: { error, message } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function handle({ method, path, body, token }) {
  await sleep(180 + Math.random() * 160);
  const [p] = path.split("?");
  const parts = p.split("/").filter(Boolean);

  // Public
  if (method === "GET" && parts[0] === "enroll" && parts[1]) {
    const res = enrollInfo(decodeURIComponent(parts[1]));
    return res ? ok(res) : err(404, "invalid_code", "This enrollment link isn't valid.");
  }
  if (method === "POST" && p === "/login") {
    return body?.code === "bad" ? err(401, "bad_login", "That sign-in link has expired.") : ok({ token: "mock-token" });
  }
  if (method === "POST" && p === "/recover") {
    return body?.secret === "dev-secret" ? ok({ login_code: "mock-login" }) : err(403, "forbidden", "That setup secret is wrong.");
  }
  if (method === "POST" && p === "/bye") return ok({ ok: true });

  if (!token) return err(401, "unauthorized", "This device isn't connected to clare.");

  if (method === "GET" && p === "/me") return ok(me());

  if (method === "POST" && p === "/enroll-code") {
    const code = `mock${(++db.seq).toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const expires_at = later(7 * DAY);
    db.codes.set(code, { mode: "progressive", started: null, devices: [], expires_at });
    return ok({ code, admin: body?.admin === true, group_id: body?.group_id || null, expires_at });
  }

  if (parts[0] === "groups") {
    const g = parts[1] ? db.groups.find((x) => x.id === parts[1]) : null;
    if (parts[1] && !g) return err(404, "not_found", "That group is gone.");
    if (method === "DELETE" && g) {
      db.groups = db.groups.filter((x) => x !== g);
      for (const d of db.devices) if (d.group_id === g.id) d.group_id = null;
      return ok({ ok: true });
    }
    if ((method === "POST" && !g) || (method === "PATCH" && g)) {
      const label = typeof body?.label === "string" ? body.label.trim().slice(0, 40) : g?.label;
      if (!label) return err(400, "bad_label", "Give the group a name.");
      const share = body?.budget_pct === undefined ? g?.budget_pct : Number(body.budget_pct);
      if (!(share >= 1 && share <= 100)) return err(400, "bad_budget", "A group's share has to be between 1% and 100%.");
      const group = g || { id: `g${++db.seq}`, created_at: new Date().toISOString() };
      Object.assign(group, { label, budget_pct: share });
      if (!g) db.groups.push(group);
      if (Array.isArray(body?.device_ids)) {
        for (const d of db.devices) {
          if (body.device_ids.includes(d.id)) d.group_id = group.id;
          else if (d.group_id === group.id) d.group_id = null;
        }
      }
      return ok({ id: group.id });
    }
  }

  if (parts[0] === "devices" && parts[1]) {
    const d = db.devices.find((x) => x.id === parts[1]);
    if (!d) return err(404, "not_found", "That device is gone.");
    if (method === "PATCH") {
      if (typeof body?.label === "string" && body.label.trim()) d.label = body.label.trim().slice(0, 80);
      if (typeof body?.admin === "boolean") d.admin = body.admin;
      if (body?.parent_id !== undefined) d.parent_id = body.parent_id;
      if (body?.group_id !== undefined) d.group_id = body.group_id;
      if (body?.budget_pct === null) d.budget_pct = null;
      else if (body?.budget_pct !== undefined) {
        const v = Number(body.budget_pct);
        if (!(v >= 0.5 && v <= 100)) return err(400, "bad_budget", "A device cap has to be between 0.5% and 100%.");
        d.budget_pct = v;
      }
      return ok({ ok: true });
    }
    if (method === "DELETE") {
      for (const x of db.devices) if (x === d || (x.parent_id === d.id && !x.removed_at)) x.removed_at = x.removed_at || new Date().toISOString();
      return ok({ ok: true });
    }
  }

  if (method === "POST" && parts[0] === "alerts" && parts[2] === "resolve") {
    const a = db.alerts.find((x) => String(x.id) === parts[1]);
    if (a) a.resolved_at = new Date().toISOString();
    return ok({ ok: true });
  }

  if (method === "PATCH" && p === "/settings") {
    const a = db.account;
    if (body.account_name) a.name = body.account_name;
    if (body.owner_name) a.owner_name = body.owner_name;
    if (body.plan) a.plan = body.plan;
    if (body.budget_pct !== undefined) a.budget_pct = Number(body.budget_pct);
    if (body.warn_pct !== undefined) a.warn_pct = Number(body.warn_pct);
    if (typeof body.enforce === "boolean") a.enforce = body.enforce;
    if (typeof body.strict_hooks === "boolean") a.strict_hooks = body.strict_hooks;
    if (body.capacity_manual !== undefined) a.capacity_manual = body.capacity_manual;
    return ok({ ok: true });
  }

  return err(404, "not_found", `Mock has no route for ${method} ${p}`);
}
