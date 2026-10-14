// dash.html — the owner's dashboard: this week's usage, every enrolled device, alerts, settings.
// Auth: #login=<code> → POST /login → token in localStorage. Polls GET /me every 15 s.
// Units: "points" = % of the account's official weekly limit (see docs/ARCHITECTURE.md).

import { api, ApiError, getToken, setToken, clearToken, webUrl } from "./api.js";
import { $, $$, esc, icon, markSvg, bindCopy, toast, setBusy } from "./ui.js";
import { pct, pts, relTime, whenLocal, minutesSince, shortDate, credits, osName, browserName } from "./format.js";

const POLL_MS = 15000;
const app = $("#app");
const banner = $("#banner");
const footer = $("#footer");
const topActions = $("#topbar-actions");
$("#wordmark").innerHTML = `${markSvg(26)}<span>clare</span>`;

let data = null; // last GET /me payload
let lastOkAt = null;
let pollTimer = null;
let pendingRender = false;
const ui = { editing: null };

/* ================= boot & data ================= */

async function boot() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const login = hash.get("login");
  if (login) {
    history.replaceState(null, "", location.pathname + location.search);
    setLoadingText("Signing you in…");
    try {
      const res = await api("/login", { method: "POST", body: { code: login }, auth: false });
      setToken(res.token);
    } catch (err) {
      if (!getToken()) {
        renderSignedOut(
          err.status === 0
            ? err.message
            : "That sign-in link was already used or is more than 10 minutes old. Open the dashboard again from the clare extension, or run clare dashboard.",
        );
        return;
      }
    }
  }
  if (!getToken()) {
    renderSignedOut();
    return;
  }
  await refresh({ first: true });
  startPolling();
}

async function refresh({ first = false } = {}) {
  try {
    const next = await api("/me");
    data = next;
    lastOkAt = new Date().toISOString();
    banner.innerHTML = "";
    if (focusInsideApp() && !first) pendingRender = true;
    else render();
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 410)) {
      clearToken();
      stopPolling();
      renderSignedOut("Your sign-in has expired. Open the dashboard again from the clare extension, or run clare dashboard.");
      return;
    }
    if (first || !data) {
      renderFatal(err.message);
      return;
    }
    banner.innerHTML = `<div class="notice notice-warn stale">${icon("alert", 18)}<p>Can't reach clare right now. Showing what we had ${esc(relTime(lastOkAt))}. We'll keep trying.</p></div>`;
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (!document.hidden && !anyDialogOpen()) refresh();
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && getToken() && data) refresh();
});

function anyDialogOpen() {
  return $$("dialog[open]").length > 0;
}

function focusInsideApp() {
  const a = document.activeElement;
  return !!a && a !== document.body && app.contains(a) && (ui.editing || a.matches("input, select, textarea"));
}

app.addEventListener("focusout", () => {
  setTimeout(() => {
    if (pendingRender && !focusInsideApp()) {
      pendingRender = false;
      render();
    }
  }, 0);
});

/* ================= helpers ================= */

const account = () => data?.account || {};
const devices = () => data?.devices || [];
const byId = (id) => devices().find((d) => d.id === id);
const enrollUrl = (code) => `${webUrl}/enroll.html#${code}`;
const isEstimate = () => account().basis === "estimate";
const about = () => (isEstimate() ? "about " : "");

// Color follows the device, never its rank: the 6 categorical slots go to devices in the order
// they were enrolled; anything past 6 shares the neutral "other" color.
const SLOTS = 6;
function colorFor(id) {
  const order = [...devices()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const i = order.findIndex((d) => d.id === id);
  return i >= 0 && i < SLOTS ? `var(--p${i + 1})` : "var(--other)";
}

function deviceLabel(d) {
  if (d.label) return d.label;
  const os = osName(d.os);
  return d.kind === "cli" ? `Claude Code${os ? ` on ${os}` : ""}` : `${browserName(d.browser) || "Browser"}${os ? ` on ${os}` : ""}`;
}

function deviceSub(d) {
  const os = osName(d.os);
  const parts = [d.kind === "cli" ? "Claude Code" : `${browserName(d.browser) || "Browser"} extension`];
  if (os && !deviceLabel(d).includes(os)) parts.push(os);
  if (d.created_at) parts.push(`added ${relTime(d.created_at)}`);
  return parts.join(" · ");
}

function connectivityLine(d) {
  if (d.connectivity === "removed" || d.removed_at) {
    return { dot: "removed", text: `Removed ${relTime(d.removed_at)}`, tone: "bad" };
  }
  if (d.connectivity === "problem") {
    return { dot: "problem", text: d.problem ? `Needs attention: ${d.problem}` : "Needs attention", tone: "warn" };
  }
  if (d.connectivity === "online") return { dot: "online", text: `Online · checked in ${relTime(d.last_seen_at)}`, tone: "ok" };
  const mins = minutesSince(d.last_seen_at);
  if (mins > 24 * 60) {
    const days = Math.floor(mins / 1440);
    return { dot: "stale", text: `Offline · not seen for ${days} day${days === 1 ? "" : "s"}`, tone: "warn" };
  }
  return { dot: "offline", text: d.last_seen_at ? `Offline · last seen ${relTime(d.last_seen_at)}` : "Not seen yet", tone: "" };
}

function enforcementChip(d) {
  if (d.enforcement === "removed" || d.removed_at) return `<span class="chip chip-neutral">Removed</span>`;
  if (d.enforcement === "unverified") return `<span class="chip chip-warn">Can't verify</span>`;
  return account().enforce === false ? `<span class="chip chip-ok">Monitored</span>` : `<span class="chip chip-ok">Enforced</span>`;
}

function unverifiedWhy(d) {
  if (d.enforcement !== "unverified") return "";
  const fix = d.kind === "cli"
    ? "Run <code>sudo clare doctor</code> on that computer to check and repair it."
    : "Open the clare extension's popup in that browser to check it.";
  if (d.connectivity === "problem") {
    return `Its last check-in reported a problem${d.problem ? ` (${esc(d.problem)})` : ""}. clare restores its own files when it can. ${fix}`;
  }
  return `It hasn't checked in ${d.last_seen_at ? `since ${esc(relTime(d.last_seen_at))}` : "yet"}, so clare can't confirm the budget holds there. If it's asleep or offline, there's nothing to do; it catches up when it's back.`;
}

const STATE_CHIP = {
  ok: ["chip-ok", "On track"],
  warn: ["chip-warn", "Getting close"],
  blocked: ["chip-bad", "Budget used up"],
  over: ["chip-bad", "Over budget"],
};

function stateChip(state) {
  const [cls, text] = STATE_CHIP[state] || STATE_CHIP.ok;
  return `<span class="chip ${cls}">${text}</span>`;
}

const MODEL_NAMES = { fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };

function modelSplit(byModel) {
  const entries = Object.entries(byModel || {}).filter(([, v]) => v > 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (!(total > 0)) return "";
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${MODEL_NAMES[k] || k} ${Math.round((v / total) * 100)}%`)
    .join(" · ");
}

/* ================= render ================= */

function render() {
  if (!data) return;
  app.setAttribute("aria-busy", "false");
  renderTopbar();

  app.innerHTML = `
    ${overviewHtml()}
    ${alertsHtml(data.alerts || [])}
    ${devicesSectionHtml()}
    ${dailyHtml()}
  `;

  footer.hidden = false;
  footer.innerHTML = `
    <span>${account().owner_name ? `Signed in as <strong>${esc(account().owner_name)}</strong>` : "Signed in"}</span>
    <span class="footer-right"><span class="muted">Updated ${esc(relTime(lastOkAt))}</span>
      <button class="btn btn-ghost btn-sm" data-action="signout">${icon("logout", 16)}<span>Sign out</span></button></span>`;

  wireViz();
  if (ui.editing) wireEditor(ui.editing);
}

function renderTopbar() {
  topActions.innerHTML = `
    <button class="btn icon-btn btn-ghost" data-action="settings" aria-label="Settings" title="Settings">${icon("settings", 20)}</button>
    <button class="btn btn-primary" data-action="add-device">${icon("plus", 18)}<span>Add a device</span></button>`;
}

/* ---------- overview: the weekly limit as one bar ---------- */

function limitSegments(acc) {
  const segs = [];
  if ((acc.before_clare || 0) > 0.05) {
    segs.push({ key: "before", name: "Before clare", value: acc.before_clare, color: "var(--before)", note: "Already used this week before clare was set up." });
  }
  const order = [...devices()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  let other = 0;
  order.forEach((d, i) => {
    const v = d.usage?.points || 0;
    if (!(v > 0.05)) return;
    if (i >= SLOTS) {
      other += v;
      return;
    }
    segs.push({ key: d.id, name: deviceLabel(d), value: v, color: colorFor(d.id) });
  });
  if (other > 0.05) segs.push({ key: "other", name: "Other devices", value: other, color: "var(--other)" });
  if ((acc.unobserved || 0) > 0.05) {
    segs.push({ key: "unobserved", name: "Unobserved", value: acc.unobserved, color: "var(--before)", texture: true,
      note: "Used where clare couldn't see it: Claude's phone apps, another browser, claude.ai/code, or a computer without clare." });
  }
  return segs;
}

function overviewHtml() {
  const acc = account();
  const st = data.status || {};
  const used = acc.used ?? st.account?.used ?? 0;
  const budget = acc.budget_pct ?? st.account?.budget ?? 100;
  const resets = acc.week?.resets_at || st.resets_at;
  const meter = acc.meter;
  const week = meter?.seven_day;
  const five = meter?.five_hour;

  const meterLine = week && typeof week.pct === "number"
    ? `<span class="overview-meta-item">${icon("meter", 16)}<span>Claude's meter read ${esc(relTime(meter.at))}${meter.device_label ? ` on ${esc(meter.device_label)}` : ""}</span></span>`
    : `<span class="overview-meta-item">${icon("meter", 16)}No reading of Claude's meter yet this week</span>`;
  const fiveLine = five && typeof five.pct === "number" && (!five.resets_at || new Date(five.resets_at) > new Date())
    ? `<span class="overview-meta-item"><span>5-hour window <strong class="num">${pct(five.pct)}</strong>${five.resets_at ? `, resets ${esc(whenLocal(five.resets_at))}` : ""}</span></span>`
    : "";

  const segs = limitSegments(acc);
  const shown = segs.reduce((s, x) => s + x.value, 0);
  const scale = Math.max(100, used, shown);
  const fillW = (Math.min(shown, scale) / scale) * 100;
  const budgetX = (Math.min(budget, scale) / scale) * 100;
  const bar = segs
    .map((s, i) => {
      const tip = `${s.name}: ${about()}${pts(s.value)} of the weekly limit`;
      return `<div class="lim-seg ${s.texture ? "is-texture" : ""} ${i === segs.length - 1 ? "is-end" : ""}" style="flex:${s.value} 1 0;--c:${s.color}" tabindex="0" role="img" aria-label="${esc(tip)}" data-tip="${esc(tip)}"></div>`;
    })
    .join("");

  const legend = segs
    .map((s) => `<li style="--c:${s.color}"><span class="swatch ${s.texture ? "is-texture" : ""}" aria-hidden="true"></span>
        <span class="legend-name">${esc(s.name)}</span><span class="legend-val num">${pts(s.value)}</span></li>`)
    .join("");

  const notes = [];
  if (isEstimate()) {
    notes.push(`<strong>Estimated.</strong> No device has read Claude's own usage meter this week, so these numbers come from the activity clare saw. Claude Code's status line and the browser extension both take readings.`);
  }
  if ((acc.pending || 0) > 0.05 && !isEstimate()) {
    notes.push(`Includes about ${pts(acc.pending)} from your latest activity that Claude's meter hasn't shown yet.`);
  }
  for (const s of segs) if (s.note) notes.push(`<strong>${esc(s.name)}:</strong> ${esc(s.note)}`);

  const budgetLabel = budget >= 100 ? "Budget: full limit" : `Budget ${pts(budget)}`;
  const enforceLine = acc.enforce === false
    ? `Monitor only: clare never blocks, it just shows where you are.`
    : `clare blocks new Claude Code prompts and claude.ai messages on enrolled devices at the budget.`;

  return `
    <section class="overview" aria-labelledby="acct-title">
      <div class="overview-head">
        <h1 id="acct-title">${esc(acc.name || "Your Claude")}</h1>
        <p class="overview-meta">
          ${resets ? `<span class="overview-meta-item">${icon("refresh", 16)}<span>Week resets <strong>${esc(whenLocal(resets))}</strong></span></span>` : ""}
          ${meterLine}
          ${fiveLine}
        </p>
      </div>
      <figure class="account-viz">
        <div class="hero-row">
          <p class="hero-num"><span class="usage-pct num">${isEstimate() ? "~" : ""}${pts(used)}</span>
            <span class="muted">of this week's limit used</span></p>
          ${stateChip(st.state)}
        </div>
        ${st.message ? `<p class="status-msg">${esc(st.message)}</p>` : ""}
        <div class="lim-wrap">
          <div class="lim-marker ${budgetX > 80 ? "is-right" : ""}" style="--x:${budgetX}%" aria-hidden="true"><span>${budgetLabel}</span></div>
          <div class="lim-bar" role="img" aria-label="${esc(`${about()}${pts(used)} of the weekly limit used; budget ${pts(budget)}`)}">
            <div class="lim-fill" style="width:${fillW}%">${bar}</div>
          </div>
          <div class="lim-scale muted small" aria-hidden="true"><span>0%</span><span>Weekly limit</span><span>${scale > 100 ? pts(scale) : "100%"}</span></div>
        </div>
        ${segs.length ? `<ul class="legend">${legend}</ul>` : `<p class="muted small">Nothing used yet this week.</p>`}
        <div class="budget-line small">
          <p><strong>${esc(budget >= 100 ? "Budget: the full weekly limit" : `Budget: ${pts(budget)} of the weekly limit`)}</strong>, warning at ${pct(acc.warn_pct ?? 80)} of it.
            <span class="muted">${enforceLine}</span></p>
          <button class="btn btn-sm link-btn" data-action="settings">${icon("settings", 16)}<span>Change</span></button>
        </div>
        ${notes.length ? `<ul class="viz-notes muted small">${notes.map((n) => `<li>${n}</li>`).join("")}</ul>` : ""}
      </figure>
    </section>`;
}

/* ---------- alerts ---------- */

const ALERT_META = {
  device_enrolled: { icon: "plug", tone: "ok" },
  device_removed: { icon: "unplug", tone: "bad" },
  device_offline: { icon: "unplug", tone: "warn" },
  config_changed: { icon: "shield", tone: "bad" },
  unobserved_usage: { icon: "eye", tone: "warn" },
};

function alertsHtml(alerts) {
  if (!alerts.length) return "";
  return `
    <section class="alerts" aria-labelledby="alerts-title">
      <h2 id="alerts-title" class="sr-only">Alerts</h2>
      <ul class="alert-list">
        ${alerts
          .map((a) => {
            const m = ALERT_META[a.kind] || { icon: "alert", tone: "warn" };
            return `<li class="alert-item alert-${m.tone}" data-alert="${esc(a.id)}">
              <span class="alert-icon">${icon(m.icon, 18)}</span>
              <p>${esc(a.message)} <span class="muted">${esc(relTime(a.created_at))}</span></p>
              <button class="btn btn-ghost btn-sm" data-action="dismiss" data-id="${esc(a.id)}">Dismiss</button>
            </li>`;
          })
          .join("")}
      </ul>
    </section>`;
}

/* ---------- devices ---------- */

function devicesSectionHtml() {
  const list = devices();
  const active = list.filter((d) => !d.removed_at && d.enforcement !== "removed");
  const unverified = active.filter((d) => d.enforcement === "unverified");
  const order = (d) => (d.removed_at ? 2 : d.enforcement === "unverified" ? 1 : 0);
  const sorted = [...list].sort((a, b) => order(a) - order(b) || new Date(a.created_at) - new Date(b.created_at));
  const count = active.length === 1 ? "1 connected" : `${active.length} connected`;
  return `
    <section class="devices-sec" aria-labelledby="devices-title">
      <div class="section-head">
        <h2 id="devices-title">Devices</h2>
        <span class="muted">${list.length ? count : ""}</span>
      </div>
      ${unverified.length
        ? `<div class="notice notice-warn unverified-note">${icon("shield", 18)}<p><strong>${unverified.length === 1 ? "1 device" : `${unverified.length} devices`} can't be verified right now.</strong> clare can only confirm the budget holds on devices that are online and healthy.</p></div>`
        : ""}
      ${list.length ? `<ul class="device-list">${sorted.map(deviceCardHtml).join("")}</ul>` : emptyDevicesHtml()}
    </section>`;
}

function deviceCardHtml(d) {
  const removed = !!d.removed_at || d.enforcement === "removed";
  const c = connectivityLine(d);
  const u = d.usage || {};
  const cap = d.budget_pct;
  const capPct = cap > 0 ? ((u.points || 0) / cap) * 100 : null;
  const capState = capPct === null ? "ok" : capPct >= 100 ? "blocked" : capPct >= (account().warn_pct ?? 80) ? "warn" : "ok";
  const split = modelSplit(u.by_model);
  const why = unverifiedWhy(d);
  const editing = ui.editing === d.id;
  return `
    <li class="dcard ${removed ? "is-removed" : ""}" data-id="${esc(d.id)}" style="--c:${colorFor(d.id)}">
      <div class="dcard-top">
        <span class="dcard-icon" aria-hidden="true">${icon(d.kind === "cli" ? "terminal" : "browser", 20)}</span>
        <div class="dcard-id">
          <h3>${esc(deviceLabel(d))}</h3>
          <p class="dcard-sub">${esc(deviceSub(d))}</p>
        </div>
        ${enforcementChip(d)}
      </div>
      <p class="dcard-status" data-tone="${c.tone}"><span class="dot dot-${c.dot}" aria-hidden="true"></span>${esc(c.text)}</p>
      ${why ? `<p class="dcard-why">${why}</p>` : ""}
      <div class="dcard-usage">
        <p class="usage-line"><span class="usage-pct num">${isEstimate() ? "~" : ""}${pts(u.points || 0)}</span>
          <span class="muted">of this week's limit${removed ? ", still counted" : ""}</span></p>
        ${cap > 0
          ? `<div class="meter" data-state="${capState}" role="progressbar" aria-label="${esc(deviceLabel(d))}: how much of its cap is used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(Math.min(capPct, 100))}">
              <div class="meter-fill" style="width:${Math.min(capPct, 100)}%"></div>
            </div>
            <p class="small muted">Cap <strong class="num cap-val">${pts(cap)}</strong> of the weekly limit · ${pct(capPct)} of the cap used</p>`
          : ""}
        ${split ? `<p class="usage-split muted small">${esc(split)}</p>` : ""}
      </div>
      ${removed
        ? ""
        : `<div class="dcard-actions">
            <button class="btn btn-sm" data-action="edit" data-id="${esc(d.id)}" aria-expanded="${editing}">${icon("edit", 16)}<span>${cap > 0 ? "Rename or change cap" : "Rename or set a cap"}</span></button>
            <button class="btn btn-sm btn-ghost btn-danger" data-action="remove" data-id="${esc(d.id)}">${icon("trash", 16)}<span>Remove</span></button>
          </div>`}
      ${editing && !removed ? editorHtml(d) : ""}
    </li>`;
}

function emptyDevicesHtml() {
  return `
    <div class="empty panel">
      <span class="connect-self-icon">${icon("laptop", 22)}</span>
      <h3>No devices yet</h3>
      <p class="muted">Add each computer where you use Claude Code, and each browser where you use claude.ai. Until then clare can only show Claude's meter, not where the usage came from, and nothing is enforced.</p>
      <div class="empty-actions">
        <button class="btn btn-primary" data-action="add-device">${icon("plus", 18)}<span>Add a device</span></button>
      </div>
    </div>`;
}

/* ---------- inline device editor ---------- */

function editorHtml(d) {
  const has = d.budget_pct > 0;
  const value = has ? Math.max(1, Math.round(d.budget_pct)) : 25;
  return `
    <form class="editor" data-editor="${esc(d.id)}">
      <div class="field">
        <label class="field-label" for="label-${esc(d.id)}">Name</label>
        <input class="input" id="label-${esc(d.id)}" name="label" maxlength="80" value="${esc(d.label || "")}" placeholder="${esc(deviceLabel(d))}">
      </div>
      <label class="check-row">
        <input type="checkbox" name="capped" ${has ? "checked" : ""}>
        <span><strong>Cap this device</strong><br>
        <span class="muted small">Limits how much of the weekly limit this device may use, whatever the account total is. Useful to keep headroom for another machine.</span></span>
      </label>
      <div class="cap-row" ${has ? "" : "hidden"}>
        <div class="editor-row">
          <label class="field-label" for="cap-${esc(d.id)}">Cap</label>
          <output class="editor-value num" id="cap-out-${esc(d.id)}" for="cap-${esc(d.id)}">${value}%</output>
        </div>
        <input class="range" type="range" id="cap-${esc(d.id)}" name="cap" min="1" max="100" step="1" value="${value}">
        <div class="range-scale muted small"><span>1%</span><span>100%</span></div>
        <p class="editor-preview" id="cap-preview-${esc(d.id)}"></p>
      </div>
      <p class="field-error" data-error hidden></p>
      <div class="editor-foot">
        <button type="button" class="btn btn-sm btn-ghost" data-action="cancel-edit">Cancel</button>
        <button type="submit" class="btn btn-sm btn-primary">Save</button>
      </div>
    </form>`;
}

function wireEditor(id) {
  const d = byId(id);
  const form = $(`[data-editor="${CSS.escape(id)}"]`, app);
  if (!d || !form) return;
  const range = form.elements.cap;
  const capped = form.elements.capped;
  const row = $(".cap-row", form);
  const out = $(`#cap-out-${CSS.escape(id)}`);
  const preview = $(`#cap-preview-${CSS.escape(id)}`);
  const update = () => {
    const v = Number(range.value);
    out.textContent = `${v}%`;
    range.style.setProperty("--fill", `${((v - 1) / 99) * 100}%`);
    const used = d.usage?.points || 0;
    preview.innerHTML = `This device can use up to <strong>${v}%</strong> of the weekly limit. It has used ${pts(used)} so far this week${used >= v ? `, so it would be <strong>${account().enforce === false ? "over its cap" : "blocked"}</strong> until the week resets` : ""}.`;
  };
  range.addEventListener("input", update);
  capped.addEventListener("change", () => {
    row.hidden = !capped.checked;
    if (capped.checked) range.focus();
  });
  update();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type="submit"]');
    const errBox = $("[data-error]", form);
    errBox.hidden = true;
    const body = {
      label: form.elements.label.value.trim() || undefined,
      budget_pct: capped.checked ? Number(range.value) : null,
    };
    setBusy(btn, true, "Saving…");
    try {
      await api(`/devices/${encodeURIComponent(id)}`, { method: "PATCH", body });
      ui.editing = null;
      toast(body.budget_pct ? `Saved. ${body.label || deviceLabel(d)} is capped at ${body.budget_pct}% of the weekly limit.` : "Saved.");
      await refresh();
      render();
    } catch (err) {
      setBusy(btn, false);
      errBox.textContent = err.message;
      errBox.hidden = false;
    }
  });
  form.elements.label.focus();
}

/* ---------- last 14 days: stacked columns by device ---------- */

function last14() {
  const days = [];
  const today = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }
  return days;
}

/** Credits → points using this week's ratio across devices (null when there's nothing to go on). */
function pointsPerCredit() {
  let p = 0;
  let c = 0;
  for (const d of devices()) {
    p += d.usage?.points || 0;
    c += d.usage?.credits || 0;
  }
  return p > 0 && c > 0 ? p / c : null;
}

function niceMax(v) {
  if (!(v > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

/** A column segment whose top corners are rounded (the data end); the baseline end stays square. */
function colPath(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function dailyHtml() {
  const rows = data.daily || [];
  if (!rows.length) return "";
  const ppc = pointsPerCredit();
  const toVal = (credits) => (ppc ? credits * ppc : credits);
  const fmt = (v) => (ppc ? pts(v) : `${credits(v)} credits`);
  const days = last14();
  const order = [...devices()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const seen = new Set(rows.map((r) => r.device_id));
  const series = order.filter((d) => seen.has(d.id));
  // Rows for devices no longer listed (removed long ago) still count, as "Other devices".
  const known = new Set(series.map((d) => d.id));
  const keyOf = (id) => (known.has(id) && order.findIndex((d) => d.id === id) < SLOTS ? id : "other");
  const keys = [...series.filter((d) => keyOf(d.id) === d.id).map((d) => d.id)];
  if (rows.some((r) => keyOf(r.device_id) === "other")) keys.push("other");
  const nameOf = (k) => (k === "other" ? "Other devices" : deviceLabel(byId(k)));
  const colorOf = (k) => (k === "other" ? "var(--other)" : colorFor(k));

  const grid = days.map((date) => {
    const vals = {};
    for (const r of rows) if (r.date === date) vals[keyOf(r.device_id)] = (vals[keyOf(r.device_id)] || 0) + toVal(r.credits || 0);
    return { date, vals, total: Object.values(vals).reduce((s, v) => s + v, 0) };
  });
  const maxTotal = Math.max(...grid.map((g) => g.total));
  if (!(maxTotal > 0)) return "";
  const top = niceMax(maxTotal);

  // Drawn at the container's real width so text stays at its true size (no viewBox scaling).
  const W = Math.max(300, Math.min(1000, Math.round((app.clientWidth || 720) - 34)));
  const H = 200;
  const padL = 40;
  const padR = 8;
  const padT = 10;
  const padB = 26;
  const plotH = H - padT - padB;
  const band = (W - padL - padR) / days.length;
  const barW = Math.min(28, band * 0.62);
  const y = (v) => padT + plotH - (v / top) * plotH;
  const labelEvery = Math.max(1, Math.ceil(48 / band)); // "Oct 14" needs ~48px
  const ticks = [0, top / 2, top];

  const gridLines = ticks
    .map((t) => `<line x1="${padL}" x2="${W - padR}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" class="${t === 0 ? "axis" : "gridline"}"/>
      <text x="${padL - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end" class="tick">${esc(ppc ? pts(t) : credits(t))}</text>`)
    .join("");

  const cols = grid
    .map((g, i) => {
      const x = padL + i * band + (band - barW) / 2;
      let base = 0;
      const present = keys.filter((k) => (g.vals[k] || 0) > 0);
      const segs = present
        .map((k, j) => {
          const v = g.vals[k];
          const y1 = y(base + v);
          const y0 = y(base);
          base += v;
          const gap = j > 0 ? 2 : 0; // surface gap between stacked fills
          const h = Math.max(0, y0 - y1 - gap);
          if (h <= 0) return "";
          const isTop = j === present.length - 1;
          return isTop
            ? `<path d="${colPath(x, y1, barW, h, 4)}" fill="${colorOf(k)}"/>`
            : `<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${colorOf(k)}"/>`;
        })
        .join("");
      const tip = g.total > 0
        ? `${shortDate(g.date)}\n${present.map((k) => `${nameOf(k)}: ${fmt(g.vals[k])}`).join("\n")}${present.length > 1 ? `\nTotal: ${fmt(g.total)}` : ""}`
        : `${shortDate(g.date)}\nNo activity`;
      const label = (days.length - 1 - i) % labelEvery === 0
        ? `<text x="${(padL + i * band + band / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="tick">${esc(dayTick(g.date, i === days.length - 1))}</text>`
        : "";
      return `${segs}${label}<rect class="col-hit" x="${(padL + i * band).toFixed(1)}" y="${padT}" width="${band.toFixed(1)}" height="${plotH}" data-tip="${esc(tip)}"/>`;
    })
    .join("");

  const legend = keys
    .map((k) => `<li style="--c:${colorOf(k)}"><span class="swatch" aria-hidden="true"></span><span class="legend-name">${esc(nameOf(k))}</span></li>`)
    .join("");

  const busiest = grid.reduce((a, b) => (b.total > a.total ? b : a));
  const summary = `Daily Claude activity by device over the last 14 days. Busiest day: ${shortDate(busiest.date)}, ${fmt(busiest.total)}.`;
  const table = `<table class="data-table small">
      <thead><tr><th scope="col">Day</th>${keys.map((k) => `<th scope="col">${esc(nameOf(k))}</th>`).join("")}<th scope="col">Total</th></tr></thead>
      <tbody>${grid
        .map((g) => `<tr><th scope="row">${esc(shortDate(g.date))}</th>${keys.map((k) => `<td class="num">${g.vals[k] ? esc(fmt(g.vals[k])) : "–"}</td>`).join("")}<td class="num">${g.total ? esc(fmt(g.total)) : "–"}</td></tr>`)
        .join("")}</tbody>
    </table>`;

  return `
    <section class="daily" aria-labelledby="daily-title">
      <div class="section-head">
        <h2 id="daily-title">Last 14 days</h2>
        <span class="muted small">${ppc ? "Estimated % of the weekly limit per day" : "Credits per day"}</span>
      </div>
      <figure class="daily-fig panel">
        ${keys.length > 1 ? `<ul class="legend">${legend}</ul>` : ""}
        <svg class="daily-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(summary)}">
          ${gridLines}${cols}
        </svg>
        <details class="disclose table-toggle">
          <summary>Show as a table${icon("chevron", 16)}</summary>
          <div class="disclose-body table-scroll">${table}</div>
        </details>
      </figure>
    </section>`;
}

function dayTick(isoDate, isToday) {
  if (isToday) return "Today";
  const d = new Date(`${isoDate}T12:00:00`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* ---------- tooltip ---------- */

const tip = $("#viz-tip");

function showTip(text, clientX, clientY) {
  tip.textContent = text;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, clientX - r.width / 2));
  const top = clientY - r.height - 12 < 8 ? clientY + 16 : clientY - r.height - 12;
  tip.style.transform = `translate(${left}px, ${top}px)`;
}

function hideTip() {
  tip.hidden = true;
}

function wireViz() {
  for (const el of $$(".lim-seg", app)) {
    el.addEventListener("pointermove", (e) => showTip(el.dataset.tip, e.clientX, e.clientY));
    el.addEventListener("pointerleave", hideTip);
    el.addEventListener("focus", () => {
      const r = el.getBoundingClientRect();
      showTip(el.dataset.tip, r.left + r.width / 2, r.top);
    });
    el.addEventListener("blur", hideTip);
  }
  for (const svg of $$(".daily-chart", app)) {
    for (const hit of $$(".col-hit", svg)) {
      hit.addEventListener("pointerenter", (e) => {
        hit.classList.add("is-hover");
        showTip(hit.dataset.tip, e.clientX, e.clientY);
      });
      hit.addEventListener("pointermove", (e) => showTip(hit.dataset.tip, e.clientX, e.clientY));
      hit.addEventListener("pointerleave", () => {
        hit.classList.remove("is-hover");
        hideTip();
      });
    }
  }
}

let resizeTimer;
let lastWidth = window.innerWidth;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    if (data && !focusInsideApp()) render();
  }, 150);
});

/* ================= actions ================= */

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id;

  switch (action) {
    case "add-device":
      openAddDialog();
      break;
    case "settings":
      openSettings();
      break;
    case "signout":
      clearToken();
      stopPolling();
      renderSignedOut("You're signed out.");
      break;
    case "edit":
      ui.editing = ui.editing === id ? null : id;
      render();
      break;
    case "cancel-edit": {
      const was = ui.editing;
      ui.editing = null;
      render();
      $(`[data-action="edit"][data-id="${CSS.escape(was || "")}"]`)?.focus();
      break;
    }
    case "remove":
      openRemoveDialog(byId(id));
      break;
    case "dismiss":
      await dismissAlert(id, el);
      break;
    default:
      break;
  }
});

async function dismissAlert(id, btn) {
  const item = btn.closest(".alert-item");
  item?.classList.add("is-leaving");
  try {
    await api(`/alerts/${encodeURIComponent(id)}/resolve`, { method: "POST", body: {} });
    data.alerts = (data.alerts || []).filter((a) => String(a.id) !== String(id));
    setTimeout(render, 180);
  } catch (err) {
    item?.classList.remove("is-leaving");
    toast(err.message, { tone: "bad" });
  }
}

/* ================= add-a-device dialog ================= */

const addDialog = $("#add-dialog");

async function openAddDialog() {
  addDialog.innerHTML = `
    <div class="sheet-head">
      <div>
        <h2 id="add-title">Add a device</h2>
        <p class="muted">Making an enrollment link…</p>
      </div>
      <form method="dialog"><button class="btn btn-ghost icon-btn" aria-label="Close">${icon("x", 20)}</button></form>
    </div>
    <div class="sheet-body"><div class="skel" style="height:3.4rem;border-radius:14px"></div></div>`;
  addDialog.showModal();
  try {
    const res = await api("/enroll-code", { method: "POST", body: {} });
    showAddResult(res);
  } catch (err) {
    addDialog.innerHTML = `
      <div class="sheet-head">
        <h2 id="add-title">Add a device</h2>
        <form method="dialog"><button class="btn btn-ghost icon-btn" aria-label="Close">${icon("x", 20)}</button></form>
      </div>
      <div class="sheet-body"><div class="notice notice-bad">${icon("alert", 18)}<p>${esc(err.message)}</p></div></div>
      <div class="sheet-foot">
        <form method="dialog"><button class="btn btn-ghost">Close</button></form>
        <button class="btn btn-primary" id="add-retry">${icon("refresh", 18)}<span>Try again</span></button>
      </div>`;
    $("#add-retry", addDialog).addEventListener("click", openAddDialog);
  }
}

function showAddResult({ code, expires_at }) {
  const url = enrollUrl(code);
  addDialog.innerHTML = `
    <div class="sheet-head">
      <div>
        <h2 id="add-title">Add a device</h2>
        <p class="muted">Open this link on the computer you want to add. It shows a one-line command for Claude Code and the steps for the browser extension.</p>
      </div>
      <form method="dialog"><button class="btn btn-ghost icon-btn" aria-label="Close">${icon("x", 20)}</button></form>
    </div>
    <div class="sheet-body">
      <div class="command link-box"><code id="enroll-url">${esc(url)}</code><button class="btn" id="copy-enroll">${icon("copy", 18)}<span>Copy</span></button></div>
      <p class="muted small">Works for any number of devices${expires_at ? ` until ${esc(whenLocal(expires_at))}` : " for 7 days"}. Anyone with the link can enroll a device into your account, so keep it to yourself.</p>
    </div>
    <div class="sheet-foot">
      <a class="btn" href="${esc(url)}" target="_blank" rel="noopener">${icon("external", 18)}<span>Add this computer</span></a>
      <form method="dialog"><button class="btn btn-primary">Done</button></form>
    </div>`;
  bindCopy($("#copy-enroll", addDialog), () => url);
  $("#copy-enroll", addDialog).focus();
}

addDialog.addEventListener("close", () => {
  if (data) refresh();
});

/* ================= remove dialog ================= */

const removeDialog = $("#remove-dialog");

function openRemoveDialog(d) {
  if (!d) return;
  const name = deviceLabel(d);
  const what = d.kind === "cli"
    ? "Next time it checks in, clare uninstalls itself from that computer and Claude Code there is no longer tracked or limited."
    : "Next time that browser checks in, the extension disconnects and claude.ai there is no longer tracked or limited.";
  removeDialog.innerHTML = `
    <div class="sheet-head">
      <h2 id="remove-title">Remove ${esc(name)}?</h2>
    </div>
    <div class="sheet-body">
      <p>${what}</p>
      <p class="muted">Its usage so far stays in this week's totals. To add it back later, use <strong>Add a device</strong>.</p>
      <p class="field-error" id="remove-error" hidden></p>
    </div>
    <div class="sheet-foot">
      <form method="dialog"><button class="btn btn-ghost">Cancel</button></form>
      <button class="btn btn-danger-solid" id="remove-confirm">${icon("trash", 18)}<span>Remove device</span></button>
    </div>`;
  $("#remove-confirm", removeDialog).addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    setBusy(btn, true, "Removing…");
    try {
      await api(`/devices/${encodeURIComponent(d.id)}`, { method: "DELETE" });
      removeDialog.close();
      if (ui.editing === d.id) ui.editing = null;
      toast(`${name} was removed.`);
      await refresh();
      render();
    } catch (err) {
      setBusy(btn, false);
      const box = $("#remove-error", removeDialog);
      box.textContent = err.message;
      box.hidden = false;
    }
  });
  removeDialog.showModal();
  $(".btn-ghost", removeDialog).focus();
}

/* ================= settings drawer ================= */

const settingsDialog = $("#settings-dialog");

const PLANS = [
  { id: "pro", name: "Pro", sub: "Claude Pro" },
  { id: "max5", name: "Max 5x", sub: "Claude Max, 5x usage" },
  { id: "max20", name: "Max 20x", sub: "Claude Max, 20x usage" },
];

function capacityExplain(cap) {
  const value = `<strong class="num">${credits(cap?.value ?? 0)} credits</strong>`;
  let source;
  if (cap?.source === "calibrated") source = "Measured by comparing clare's activity with Claude's own meter.";
  else if (cap?.source === "manual") source = "You set this by hand. Untick the box below to go back to automatic.";
  else source = "A starting guess from your plan. It corrects itself once devices read Claude's meter.";
  return `<p>Only used when no device has read Claude's meter this week: clare then assumes the account allows about ${value} of use per week.</p>
    <p class="muted small">${source} One credit is roughly what $1 of Claude API use would cost.</p>`;
}

function budgetPreview(budget, warn) {
  const b = Number(budget);
  const w = Number(warn);
  const warnAt = Math.round((b * w) / 10) / 10;
  return b >= 100
    ? `The budget is the whole weekly limit. clare warns at ${warnAt}% of it.`
    : `clare stops at <strong>${b}%</strong> of the weekly limit, keeping ${100 - b}% in reserve, and warns at ${warnAt}%.`;
}

function openSettings() {
  const acc = account();
  const manual = acc.capacity?.source === "manual";
  const budget = Math.round(acc.budget_pct ?? 100);
  const warn = Math.round(acc.warn_pct ?? 80);
  const enforce = acc.enforce !== false;
  settingsDialog.innerHTML = `
    <form class="settings-form" novalidate>
      <div class="sheet-head">
        <h2 id="settings-title">Settings</h2>
        <button type="button" class="btn btn-ghost icon-btn" data-close aria-label="Close">${icon("x", 20)}</button>
      </div>
      <div class="sheet-body">
        <div class="field">
          <div class="editor-row">
            <label class="field-label" for="budget">Weekly budget</label>
            <output class="editor-value num" id="budget-out" for="budget">${budget}%</output>
          </div>
          <input class="range" type="range" id="budget" name="budget_pct" min="1" max="100" step="1" value="${budget}">
          <div class="range-scale muted small"><span>1%</span><span>100% of the weekly limit</span></div>
          <p class="field-hint" id="budget-preview"></p>
        </div>
        <div class="field">
          <div class="editor-row">
            <label class="field-label" for="warn">Warn at</label>
            <output class="editor-value num" id="warn-out" for="warn">${warn}%</output>
          </div>
          <input class="range" type="range" id="warn" name="warn_pct" min="10" max="99" step="1" value="${warn}">
          <div class="range-scale muted small"><span>10%</span><span>99% of the budget</span></div>
        </div>
        <fieldset class="field plan-field">
          <legend class="field-label">At the budget</legend>
          <div class="plan-options">
            <label class="plan-option"><input type="radio" name="enforce" value="1" ${enforce ? "checked" : ""}><span><strong>Block</strong><small>New Claude Code prompts and claude.ai messages wait until the week resets.</small></span></label>
            <label class="plan-option"><input type="radio" name="enforce" value="0" ${enforce ? "" : "checked"}><span><strong>Monitor only</strong><small>Never block. Warnings and the dashboard still show where you are.</small></span></label>
          </div>
        </fieldset>
        <div class="field">
          <label class="field-label" for="acct-name">Account name</label>
          <input class="input" id="acct-name" name="account_name" maxlength="60" value="${esc(acc.name || "")}">
        </div>
        <div class="field">
          <label class="field-label" for="owner-name">Your name</label>
          <input class="input" id="owner-name" name="owner_name" maxlength="60" value="${esc(acc.owner_name || "")}">
        </div>
        <fieldset class="field plan-field">
          <legend class="field-label">Your Claude plan</legend>
          <div class="plan-options">
            ${PLANS.map((pl) => `<label class="plan-option"><input type="radio" name="plan" value="${pl.id}" ${acc.plan === pl.id ? "checked" : ""}><span><strong>${pl.name}</strong><small>${pl.sub}</small></span></label>`).join("")}
          </div>
        </fieldset>
        <details class="disclose advanced" ${acc.strict_hooks || manual ? "open" : ""}>
          <summary>Advanced${icon("chevron", 16)}</summary>
          <div class="disclose-body advanced-body">
            <label class="check-row">
              <input type="checkbox" name="strict_hooks" ${acc.strict_hooks ? "checked" : ""}>
              <span><strong>Only allow clare's Claude Code hooks</strong><br>
              <span class="muted small">Makes the budget harder to bypass on your computers, but turns off any Claude Code hooks and plugins you've set up yourself. Leave it off unless you need it.</span></span>
            </label>
            <div class="field capacity">
              <span class="field-label">Weekly capacity estimate</span>
              <div class="capacity-box">${capacityExplain(acc.capacity)}</div>
              <label class="check-row"><input type="checkbox" name="manual" ${manual ? "checked" : ""}><span>Set it by hand</span></label>
              <div class="manual-row" ${manual ? "" : "hidden"}>
                <label class="sr-only" for="cap-manual">Credits per week</label>
                <input class="input num" type="number" id="cap-manual" name="capacity_manual" min="1" step="1" inputmode="numeric" value="${manual ? Math.round(acc.capacity.value) : ""}">
                <span class="muted">credits per week</span>
              </div>
            </div>
          </div>
        </details>
        <p class="field-error" id="settings-error" hidden></p>
      </div>
      <div class="sheet-foot">
        <button type="button" class="btn btn-ghost" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>`;
  const form = $(".settings-form", settingsDialog);
  const budgetEl = form.elements.budget_pct;
  const warnEl = form.elements.warn_pct;
  const update = () => {
    $("#budget-out", settingsDialog).textContent = `${budgetEl.value}%`;
    $("#warn-out", settingsDialog).textContent = `${warnEl.value}%`;
    budgetEl.style.setProperty("--fill", `${((budgetEl.value - 1) / 99) * 100}%`);
    warnEl.style.setProperty("--fill", `${((warnEl.value - 10) / 89) * 100}%`);
    $("#budget-preview", settingsDialog).innerHTML = budgetPreview(budgetEl.value, warnEl.value);
  };
  budgetEl.addEventListener("input", update);
  warnEl.addEventListener("input", update);
  update();
  const manualBox = form.elements.manual;
  const manualRow = $(".manual-row", settingsDialog);
  manualBox.addEventListener("change", () => {
    manualRow.hidden = !manualBox.checked;
    if (manualBox.checked) form.elements.capacity_manual.focus();
  });
  for (const b of $$("[data-close]", settingsDialog)) b.addEventListener("click", () => settingsDialog.close());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#settings-error", settingsDialog);
    err.hidden = true;
    const body = {
      budget_pct: Number(budgetEl.value),
      warn_pct: Number(warnEl.value),
      enforce: form.elements.enforce.value !== "0",
      account_name: form.elements.account_name.value.trim() || undefined,
      owner_name: form.elements.owner_name.value.trim() || undefined,
      plan: form.elements.plan.value || undefined,
      strict_hooks: form.elements.strict_hooks.checked,
      capacity_manual: null,
    };
    if (manualBox.checked) {
      const v = Number(form.elements.capacity_manual.value);
      if (!(v > 0)) {
        err.textContent = "Enter how many credits the account allows per week, or untick the box.";
        err.hidden = false;
        return;
      }
      body.capacity_manual = v;
    }
    const btn = form.querySelector('[type="submit"]');
    setBusy(btn, true, "Saving…");
    try {
      await api("/settings", { method: "PATCH", body });
      settingsDialog.close();
      toast("Settings saved.");
      await refresh();
      render();
    } catch (ex) {
      setBusy(btn, false);
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
  settingsDialog.showModal();
  budgetEl.focus();
}

/* ================= signed out / errors ================= */

function setLoadingText(text) {
  const el = $("#loading-text");
  if (el) el.textContent = text;
}

function renderSignedOut(note) {
  app.setAttribute("aria-busy", "false");
  topActions.innerHTML = "";
  footer.hidden = true;
  banner.innerHTML = "";
  app.innerHTML = `
    <section class="state-screen signed-out">
      <span class="state-icon">${icon("lock", 26)}</span>
      <h1>Open your clare dashboard</h1>
      ${note ? `<p class="notice">${icon("alert", 18)}<span>${esc(note)}</span></p>` : ""}
      <p class="lede">The dashboard opens from a private sign-in link. Get one from any enrolled device:</p>
      <ul class="how">
        <li><span class="how-icon">${icon("browser", 20)}</span><span><strong>In the browser</strong><br><span class="muted">Click the clare icon in the toolbar, then <strong>Open dashboard</strong>.</span></span></li>
        <li><span class="how-icon">${icon("terminal", 20)}</span><span><strong>In a terminal</strong><br><span class="muted">Run <code>clare dashboard</code>.</span></span></li>
      </ul>
      <details class="disclose recover">
        <summary>No device enrolled yet, or lost your link?${icon("chevron", 16)}</summary>
        <form class="disclose-body recover-form" novalidate>
          <div class="field">
            <label class="field-label" for="recover-secret">Setup secret</label>
            <input class="input" id="recover-secret" name="secret" autocomplete="off" spellcheck="false">
            <p class="field-hint">It's in the <code>.clare-secret</code> file that <code>scripts/setup.sh</code> created in your clare folder. You can also run <code>scripts/setup.sh login</code>.</p>
          </div>
          <p class="field-error" id="recover-error" hidden></p>
          <button class="btn btn-primary" type="submit">Get a new dashboard link</button>
        </form>
      </details>
    </section>`;
  const form = $(".recover-form", app);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const secret = form.elements.secret.value.trim();
    const err = $("#recover-error", app);
    err.hidden = true;
    if (!secret) {
      err.textContent = "Paste the setup secret first.";
      err.hidden = false;
      return;
    }
    const btn = form.querySelector('[type="submit"]');
    setBusy(btn, true, "Checking…");
    try {
      const { login_code } = await api("/recover", { method: "POST", body: { secret }, auth: false });
      const { token } = await api("/login", { method: "POST", body: { code: login_code }, auth: false });
      setToken(token);
      app.innerHTML = "";
      await refresh({ first: true });
      startPolling();
    } catch (ex) {
      setBusy(btn, false);
      err.textContent = ex.status === 401 || ex.status === 403 ? "That secret doesn't match. Check the .clare-secret file and try again." : ex.message;
      err.hidden = false;
    }
  });
}

function renderFatal(message) {
  app.setAttribute("aria-busy", "false");
  app.innerHTML = `
    <section class="state-screen">
      <span class="state-icon">${icon("refresh", 26)}</span>
      <h1>Can't load your dashboard</h1>
      <p class="lede">${esc(message)}</p>
      <button class="btn btn-primary" id="retry">${icon("refresh", 18)}<span>Try again</span></button>
    </section>`;
  $("#retry").addEventListener("click", async () => {
    app.innerHTML = "";
    await refresh({ first: true });
    startPolling();
  });
}

boot();
