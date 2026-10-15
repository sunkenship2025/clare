// enroll.html#<code> — add a device. Asks where Claude is used on this computer and walks
// through only the steps needed, ticking each one off live as devices enroll.

import { api, ApiError, webUrl, releasesUrl, extensionUrl } from "./api.js";
import { $, $$, esc, icon, markSvg, bindCopy, announce } from "./ui.js";
import { relTime } from "./format.js";

const main = $("#enroll");
$("#wordmark").innerHTML = `${markSvg(26)}<span>clare</span>`;

const POLL_MS = 3000;
const code = parseCode();
// The extension's content script reads this attribute and enrolls this browser by itself.
main.dataset.enrollCode = code;

const state = {
  view: "loading", // loading | ready | invalid | expired | error | nocode
  info: null,
  uses: loadUses(),
  os: detectOS(),
  phone: isPhone(),
  showStepsOnPhone: false,
  ext: readExt(),
  installClickedAt: 0,
  announced: new Set(),
};

let pollTimer = null;

/* ---------------- detection & persistence ---------------- */

function parseCode() {
  let h = location.hash.replace(/^#/, "");
  try {
    h = decodeURIComponent(h);
  } catch {
    /* leave as-is */
  }
  h = h.trim();
  if (h.startsWith("code=")) h = h.slice(5);
  return h.replace(/[^A-Za-z0-9_-]/g, "");
}

function detectOS() {
  const p = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "").toLowerCase();
  if (p.includes("win")) return "windows";
  if (p.includes("linux") || p.includes("x11") || p.includes("cros")) return "linux";
  return "mac";
}

function isPhone() {
  const forced = new URLSearchParams(location.search).get("phone");
  if (forced !== null) return forced !== "0";
  const ua = navigator.userAgent || "";
  if (navigator.userAgentData && typeof navigator.userAgentData.mobile === "boolean") return navigator.userAgentData.mobile;
  return /Android|iPhone|iPod|Mobile|Windows Phone/i.test(ua) || (/iPad/.test(ua) && "ontouchend" in document);
}

function isChromium() {
  const brands = navigator.userAgentData?.brands || [];
  if (brands.some((b) => /Chromium|Google Chrome|Microsoft Edge|Brave|Opera/i.test(b.brand))) return true;
  return /Chrome\/|Edg\//.test(navigator.userAgent) && !/OPR\/|SamsungBrowser/.test(navigator.userAgent);
}

// Which steps to show is remembered per computer, not per link: it's a property of the machine.
const USES_KEY = "clare.enroll.uses";

function loadUses() {
  try {
    const saved = JSON.parse(localStorage.getItem(USES_KEY) || "null");
    if (saved && typeof saved.browser === "boolean" && typeof saved.terminal === "boolean") return saved;
  } catch {
    /* ignore */
  }
  return { terminal: true, browser: false };
}

function saveUses() {
  try {
    localStorage.setItem(USES_KEY, JSON.stringify(state.uses));
  } catch {
    /* ignore */
  }
}

/* ---------------- data ---------------- */

function devicesOf(kind) {
  return (state.info?.devices || []).filter((d) => d.kind === kind);
}

// The extension reports back through data-extension-* attributes on <main>
// (see extension/content/enroll.js).
function readExt() {
  const d = main.dataset;
  return {
    installed: !!d.extensionInstalled,
    state: d.extensionState || "",
    connected: d.extensionState === "connected" || !!d.extensionConnected,
    device: d.extensionDevice || "",
    error: d.extensionError || "",
  };
}

function isDone(use) {
  if (use === "browser") return state.ext.connected || devicesOf("extension").length > 0;
  return devicesOf("cli").length > 0;
}

function selectedUses() {
  return ["terminal", "browser"].filter((u) => state.uses[u]);
}

async function load({ quiet = false } = {}) {
  if (!code) {
    state.view = "nocode";
    render();
    return;
  }
  try {
    const info = await api(`/enroll/${encodeURIComponent(code)}`, { auth: false });
    const firstLoad = !state.info;
    state.info = info;
    state.view = info.expired ? "expired" : "ready";
    if (firstLoad) {
      // Something already enrolled with this link (an earlier visit): show that step too.
      if (devicesOf("cli").length) state.uses.terminal = true;
      if (devicesOf("extension").length || state.ext.installed) state.uses.browser = true;
    }
    if (firstLoad || !quiet) render();
    else updateLive();
  } catch (err) {
    if (quiet) return; // a failed poll isn't worth interrupting anyone for
    if (err instanceof ApiError && (err.status === 404 || err.status === 410)) state.view = err.status === 410 ? "expired" : "invalid";
    else state.view = "error";
    state.error = err.message;
    render();
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (document.hidden || state.view !== "ready") return;
    load({ quiet: true });
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/* ---------------- render ---------------- */

const DASH_HINT = `Open your <a href="dash.html">clare dashboard</a> and choose <strong>Add a device</strong> to get a fresh link.`;

function render() {
  if (state.view === "loading") return;
  if (state.view === "nocode") {
    main.innerHTML = stateScreen("link", "This page needs an enrollment link", `Links from <strong>Add a device</strong> in your dashboard end with a short code after a # sign. ${DASH_HINT}`);
    return;
  }
  if (state.view === "invalid") {
    main.innerHTML = stateScreen("link", "This link doesn't work", `It may be missing a few characters. ${DASH_HINT}`);
    return;
  }
  if (state.view === "expired") {
    main.innerHTML = stateScreen("link", "This link has expired", `Enrollment links work for 7 days. ${DASH_HINT}`);
    return;
  }
  if (state.view === "error") {
    main.innerHTML = `${stateScreen("refresh", "Can't reach clare right now", esc(state.error || "Check your internet connection and try again."))}
      <button class="btn btn-primary" id="retry">${icon("refresh", 18)}<span>Try again</span></button>`;
    $("#retry").addEventListener("click", () => {
      main.innerHTML = "";
      state.view = "loading";
      load();
    });
    return;
  }

  const info = state.info;
  const account = info.account_name ? `<span class="account-name">${esc(info.account_name)}</span>` : "your clare account";
  const showPhoneCard = state.phone && !state.showStepsOnPhone;

  main.innerHTML = `
    <section class="welcome" aria-labelledby="welcome-title">
      <span class="welcome-icon" aria-hidden="true">${icon("laptop", 28)}</span>
      <div class="welcome-text">
        <h1 id="welcome-title">Add this device to clare</h1>
        <p class="lede">Connect this computer to ${account}${info.owner_name ? ` (${esc(info.owner_name)})` : ""}. clare will count its Claude usage, apply your weekly budget here, and show it on your dashboard. About two minutes.</p>
        ${info.admin ? `<p class="muted small">This link adds <strong>admin devices</strong>: they can change the budget, caps and settings.</p>` : ""}
      </div>
    </section>

    <div id="done-slot"></div>

    ${showPhoneCard ? phoneCard() : questionAndSteps()}
  `;

  wire();
  updateLive();
}

function stateScreen(iconName, title, body) {
  return `<section class="state-screen">
      <span class="state-icon">${icon(iconName, 26)}</span>
      <h1>${title}</h1>
      <p class="lede">${body}</p>
    </section>`;
}

function phoneCard() {
  return `
    <section class="panel phone-card" aria-labelledby="phone-title">
      <span class="state-icon">${icon("laptop", 26)}</span>
      <h2 id="phone-title">Open this link on the computer you want to add</h2>
      <p class="muted">clare runs on computers. Claude's phone apps can't be enrolled; their usage shows up on your dashboard as <em>unobserved</em>.</p>
      <div class="phone-actions">
        <button class="btn btn-primary btn-lg" id="copy-link">${icon("copy", 18)}<span>Copy link</span></button>
        ${navigator.share ? `<button class="btn btn-lg" id="send-link">${icon("message", 18)}<span>Send to myself</span></button>` : ""}
      </div>
      <button class="btn btn-ghost" id="show-steps">I'm on my computer. Show me the steps.</button>
    </section>`;
}

function questionAndSteps() {
  const uses = state.uses;
  return `
    <section class="question" aria-labelledby="q-title">
      <h2 id="q-title">Where do you use Claude on this computer?</h2>
      <p class="muted">Pick one or both. Each one is enrolled separately.</p>
      <div class="choices" role="group" aria-labelledby="q-title">
        ${choice("terminal", "terminal", "Claude Code", "Any terminal, VS Code, JetBrains, the desktop app", uses.terminal)}
        ${choice("browser", "browser", "claude.ai in the browser", "Chrome, Edge, Brave or Arc", uses.browser)}
      </div>
    </section>
    <ol class="steps" id="steps" aria-label="Setup steps">${stepsHtml()}</ol>
    <p class="sr-only" aria-live="polite" id="step-live"></p>`;
}

function choice(key, iconName, title, sub, pressed) {
  return `<button type="button" class="choice" data-use="${key}" aria-pressed="${pressed}">
      <span class="choice-icon">${icon(iconName, 24)}</span>
      <span class="choice-text"><strong>${title}</strong><small>${sub}</small></span>
      <span class="choice-tick" aria-hidden="true">${icon("check", 16)}</span>
    </button>`;
}

function stepsHtml() {
  const list = selectedUses();
  if (!list.length) {
    return `<li class="steps-empty muted">Choose where you use Claude and the steps will appear here.</li>`;
  }
  return list.map((use, i) => (use === "browser" ? extensionStep(i + 1) : terminalStep(i + 1))).join("");
}

function stepFrame(n, kind, title, body) {
  return `
    <li class="step panel" data-kind="${kind}" data-done="false">
      <div class="step-head">
        <span class="step-badge" aria-hidden="true">
          <span class="step-n">${n}</span>
          <svg class="step-check" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.2 4.2L19 7" pathLength="1"/></svg>
        </span>
        <h3>${title}</h3>
        <span class="step-status" data-status></span>
      </div>
      <div class="step-body">${body}</div>
      <p class="step-connected" data-connected hidden></p>
    </li>`;
}

function extensionStep(n) {
  const warn = isChromium()
    ? ""
    : `<div class="notice notice-warn">${icon("alert", 18)}<p>The clare extension works in <strong>Chrome</strong>, <strong>Edge</strong>, <strong>Brave</strong> and <strong>Arc</strong>. Open this link in one of those to add it.</p></div>`;
  let body;
  if (extensionUrl) {
    body = `${warn}
      <ol class="substeps ext-install">
        <li>Click <strong>Add to Chrome</strong>, then <strong>Add extension</strong>.</li>
        <li>Come back to this tab. The extension enrolls this browser by itself.</li>
      </ol>
      <div class="step-actions ext-install">
        <a class="btn btn-primary btn-lg" id="add-ext" href="${esc(extensionUrl)}" target="_blank" rel="noopener">${icon("plus", 18)}<span>Add to Chrome</span></a>
      </div>`;
  } else {
    const zip = releasesUrl ? `${releasesUrl}/clare-extension.zip` : "";
    body = `${warn}
      <p class="muted small ext-install">Connecting Claude Code on this computer too? Skip this: the command walks you through every browser, with nothing to download. Later, <code>clare browser</code> does the same.</p>
      <ol class="substeps ext-install">
        <li>Download the extension.
          <div class="step-actions">
            ${zip
              ? `<a class="btn btn-primary" id="add-ext" href="${esc(zip)}" download>${icon("download", 18)}<span>Download clare for Chrome</span></a>`
              : `<span class="muted">The download isn't published yet. Run <code>node scripts/build.mjs</code> and load <code>dist/extension</code> instead.</span>`}
          </div>
        </li>
        <li>Unzip it into a folder called <strong>clare-extension</strong>.</li>
        <li>Open a new tab, paste this address and press <kbd>Enter</kbd>:
          <div class="command command-sm"><code>chrome://extensions</code><button class="btn btn-sm" id="copy-ext-url">${icon("copy", 16)}<span>Copy</span></button></div>
        </li>
        <li>Switch on <strong>Developer mode</strong> (top right), click <strong>Load unpacked</strong>, and choose the <strong>clare-extension</strong> folder.</li>
        <li>Come back to this tab. The extension enrolls this browser by itself.</li>
      </ol>`;
  }
  body = `<div class="ext-live" data-ext-live hidden></div>${body}`;
  body += `<div class="refresh-hint" id="refresh-hint" hidden>
      <p>Added it already?</p>
      <button class="btn btn-sm" id="refresh-page">${icon("refresh", 16)}<span>Reload this page</span></button>
    </div>`;
  return stepFrame(n, "extension", "Add the clare extension", body);
}

const OS_LABEL = { mac: "Mac", windows: "Windows", linux: "Linux" };

function terminalCommand(os) {
  if (os === "windows") return `$env:CLARE_CODE='${code}'; irm ${webUrl}/install.ps1 | iex`;
  return `curl -fsSL ${webUrl}/install.sh | sh -s -- ${code}`;
}

function terminalHelp(os) {
  if (os === "windows") {
    return {
      app: "PowerShell",
      paste: `Paste it into PowerShell and press <kbd>Enter</kbd>.`,
      note: `Windows asks <em>"Do you want to allow this app to make changes to your device?"</em> once. Click <strong>Yes</strong>: clare installs Claude Code managed settings for every user on this computer, which needs administrator rights.`,
    };
  }
  return {
    app: "a terminal",
    paste: `Paste it into ${os === "linux" ? "a terminal" : "Terminal"} and press <kbd>${os === "linux" ? "Enter" : "Return"}</kbd>.`,
    note: `It asks for your password once (<code>sudo</code>): clare installs Claude Code managed settings for every user on this computer, which live in a system folder.`,
  };
}

function terminalStep(n) {
  const os = state.os;
  const help = terminalHelp(os);
  const tabs = ["mac", "windows", "linux"]
    .map((o) => `<button type="button" role="tab" class="seg" data-os="${o}" aria-selected="${o === os}" tabindex="${o === os ? 0 : -1}">${OS_LABEL[o]}</button>`)
    .join("");
  const body = `
    <div class="seg-group" role="tablist" aria-label="This computer">${tabs}</div>
    <ol class="substeps">
      <li>Copy this line. ${help.paste}
        <div class="command"><code id="cmd">${esc(terminalCommand(os))}</code><button class="btn" id="copy-cmd">${icon("copy", 18)}<span>Copy</span></button></div>
      </li>
    </ol>
    <p class="muted small">Once Claude Code is connected, the command walks you through adding the clare extension to each browser on this computer, one at a time.</p>
    <div class="notice">${icon("lock", 18)}<p>${help.note}</p></div>
    <details class="disclose">
      <summary>What does it install?${icon("chevron", 16)}</summary>
      <div class="disclose-body">
        <ul class="plain-list">
          <li>The <code>clare</code> program (one file, no dependencies).</li>
          <li>Claude Code hooks and a status line, as managed settings, so every terminal and editor on this computer uses them. Your own status line keeps working.</li>
          <li>A background check-in every 5 minutes that reports this computer's health and repairs clare's files if they change.</li>
          <li>The clare browser extension, as a folder each browser loads with <strong>Load unpacked</strong>. It's kept up to date, and browsers pick up a new version when they restart.</li>
        </ul>
        <p class="muted small">Remove it any time with <code>sudo clare uninstall</code>.</p>
      </div>
    </details>`;
  return stepFrame(n, "cli", "Connect Claude Code", body);
}

/* ---------------- live updates ---------------- */

function updateLive() {
  if (state.view !== "ready") return;
  const live = $("#step-live");
  for (const step of $$(".step", main)) {
    const use = step.dataset.kind === "extension" ? "browser" : "terminal";
    const done = isDone(use);
    const wasDone = step.dataset.done === "true";
    step.dataset.done = String(done);
    const status = $("[data-status]", step);
    const connected = $("[data-connected]", step);
    if (done) {
      status.innerHTML = `<span class="chip chip-ok">Connected</span>`;
      const devs = devicesOf(step.dataset.kind);
      const latest = [...devs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      const label = latest?.label || (use === "browser" ? state.ext.device || "This browser" : "This computer");
      connected.hidden = false;
      connected.innerHTML = `${icon(use === "browser" ? "browser" : "terminal", 18)}<span><strong>${esc(label)}</strong> is connected${latest?.created_at ? ` · ${esc(relTime(latest.created_at))}` : ""}</span>`;
      if (!wasDone && !state.announced.has(use)) {
        state.announced.add(use);
        if (live) live.textContent = use === "browser" ? "The browser extension is connected." : "Claude Code is connected.";
      }
    } else {
      const connecting = use === "browser" && state.ext.state === "connecting";
      status.innerHTML = `<span class="waiting"><span class="pulse" aria-hidden="true"></span>${connecting ? "Connecting…" : "Waiting…"}</span>`;
      connected.hidden = true;
    }
    if (use === "browser") updateExtPanel(step, done);
  }

  const sel = selectedUses();
  const allDone = sel.length > 0 && sel.every(isDone);
  const slot = $("#done-slot");
  if (slot) {
    if (allDone && !slot.firstElementChild) {
      slot.innerHTML = doneCard();
      announce("This device is connected.");
    } else if (!allDone && slot.firstElementChild) {
      slot.innerHTML = "";
    }
  }
  main.classList.toggle("is-complete", allDone);
}

function updateExtPanel(step, done) {
  const live = $("[data-ext-live]", step);
  if (!live) return;
  const ext = state.ext;
  // Once the extension is in this browser, the install instructions are noise.
  for (const el of $$(".ext-install", step)) el.hidden = ext.installed && !done;
  const hint = $("#refresh-hint", step);
  if (hint && ext.installed) hint.hidden = true;

  let html = "";
  if (done) {
    html = "";
  } else if (ext.state === "error") {
    html = `<div class="notice notice-bad">${icon("alert", 18)}<div><p>${esc(ext.error || "The extension couldn't enroll this browser.")}</p>
        <div class="step-actions"><button class="btn btn-sm" data-ext-retry>${icon("refresh", 16)}<span>Try again</span></button></div></div></div>`;
  } else if (ext.installed) {
    html = `<div class="notice notice-ok">${icon("check", 18)}<p>The clare extension is in this browser. Enrolling it now…</p></div>`;
  }
  if (live.dataset.html !== html) {
    live.dataset.html = html;
    live.innerHTML = html;
    live.hidden = !html;
    // The content script runs on page load, so a reload is the reliable way to retry.
    $("[data-ext-retry]", live)?.addEventListener("click", () => location.reload());
  }
}

function doneCard() {
  const where = state.uses.browser
    ? `Click the <strong>clare</strong> icon in the browser toolbar to see this week's usage (pin it with the puzzle-piece button).`
    : `Run <code>clare status</code> in a terminal to see this week's usage.`;
  return `
    <section class="done panel" aria-labelledby="done-title">
      <span class="done-badge" aria-hidden="true">${icon("check", 28)}</span>
      <div>
        <h2 id="done-title">This device is connected.</h2>
        <p>Use Claude as usual. clare reports usage in the background and applies your weekly budget here.</p>
        <p class="muted">${where} All your devices are on the <a href="dash.html">dashboard</a>.</p>
      </div>
    </section>`;
}

/* ---------------- events ---------------- */

function wire() {
  for (const btn of $$(".choice", main)) {
    btn.addEventListener("click", () => {
      const use = btn.dataset.use;
      state.uses[use] = !state.uses[use];
      btn.setAttribute("aria-pressed", String(state.uses[use]));
      saveUses();
      $("#steps").innerHTML = stepsHtml();
      wireSteps();
      updateLive();
    });
  }
  const copyLink = $("#copy-link");
  if (copyLink) bindCopy(copyLink, () => location.href, { label: "Copy link" });
  const sendLink = $("#send-link");
  if (sendLink) {
    sendLink.addEventListener("click", async () => {
      try {
        await navigator.share({ title: "Add a device to clare", url: location.href });
      } catch {
        /* cancelled */
      }
    });
  }
  const show = $("#show-steps");
  if (show) {
    show.addEventListener("click", () => {
      state.showStepsOnPhone = true;
      render();
    });
  }
  wireSteps();
}

function wireSteps() {
  const copyCmd = $("#copy-cmd");
  if (copyCmd) bindCopy(copyCmd, () => terminalCommand(state.os));
  const copyExt = $("#copy-ext-url");
  if (copyExt) bindCopy(copyExt, () => "chrome://extensions");

  const tabs = $$(".seg", main);
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => selectOS(tab.dataset.os));
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      selectOS(next.dataset.os, true);
    });
  });

  const addExt = $("#add-ext");
  if (addExt) {
    addExt.addEventListener("click", () => {
      state.installClickedAt = Date.now();
    });
  }
  const refresh = $("#refresh-page");
  if (refresh) refresh.addEventListener("click", () => location.reload());
}

function selectOS(os, focus = false) {
  state.os = os;
  const step = $('.step[data-kind="cli"]', main);
  if (!step) return;
  const n = $(".step-n", step).textContent;
  const fresh = document.createElement("template");
  fresh.innerHTML = terminalStep(Number(n)).trim();
  step.replaceWith(fresh.content.firstElementChild);
  wireSteps();
  updateLive();
  if (focus) $(`.seg[data-os="${os}"]`, main)?.focus();
}

// Coming back from installing the extension: the content script isn't injected into an
// already-open tab, so offer a reload if enrollment hasn't happened.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (state.view === "ready") load({ quiet: true });
  if (state.installClickedAt && !isDone("browser")) {
    setTimeout(() => {
      const hint = $("#refresh-hint");
      if (hint && !isDone("browser")) hint.hidden = false;
    }, 4000);
  }
});

function onExtensionChange() {
  const was = state.ext.connected;
  state.ext = readExt();
  if (state.ext.installed && !state.uses.browser && state.view === "ready") {
    state.uses.browser = true;
    saveUses();
    render();
    return;
  }
  updateLive();
  // Just enrolled: refresh the device list so the step shows this browser's name.
  if (state.ext.connected && !was) load({ quiet: true });
}

new MutationObserver(onExtensionChange).observe(main, {
  attributes: true,
  attributeFilter: [
    "data-extension-installed",
    "data-extension-state",
    "data-extension-connected",
    "data-extension-device",
    "data-extension-error",
  ],
});

window.addEventListener("hashchange", () => location.reload());

load().then(startPolling);
