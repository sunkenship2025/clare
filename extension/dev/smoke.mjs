#!/usr/bin/env node
// Real-Chrome smoke test for the extension, against a local clare API with an EMPTY database.
// Loads the staged extension over the DevTools pipe (Chrome ignores --load-extension now),
// enrolls it from the real enroll page, then plays a *fake* claude.ai — every https://claude.ai
// request is answered locally by request interception, nothing reaches the real site.
//
//   node extension/dev/smoke.mjs --api http://localhost:8787 --web http://localhost:8788 [--shots DIR]

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const API = arg("--api", "http://localhost:8787");
const WEB = arg("--web", "http://localhost:8788");
const SHOTS = arg("--shots", null);
const CHROME = arg("--chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const SECRET = arg("--secret", "dev-secret");

const ORG = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
const CONV = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✔" : "✘"} ${name}${extra ? "  " + extra : ""}`);
};

async function call(path, { method = "GET", body, token } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

// ── minimal CDP-over-pipe client ──────────────────────────────────────────
function cdp(proc) {
  let id = 0;
  let buf = "";
  const pending = new Map();
  const handlers = [];
  proc.stdio[4].on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\0")) !== -1) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else handlers.forEach((h) => h(msg));
    }
  });
  return {
    send(method, params = {}, sessionId) {
      const msg = { id: ++id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      proc.stdio[3].write(JSON.stringify(msg) + "\0");
      return new Promise((resolve, reject) => pending.set(msg.id, { resolve, reject }));
    },
    on: (h) => handlers.push(h),
  };
}

const FAKE_PAGE = `<!doctype html><html><head><title>fake claude</title><style>
body{font:15px system-ui;margin:0;height:100vh;display:flex;flex-direction:column;justify-content:flex-end;background:#f5f3ee}
.composer{margin:24px auto;width:640px;border:1px solid #ccc;border-radius:16px;background:#fff;padding:14px;min-height:60px}
</style></head><body>
<form id="f" class="composer"><div contenteditable="true" id="box">Hi Claude</div>
<button type="submit" aria-label="Send message">↑</button></form>
<script>
  window.sent = [];
  async function send() {
    const res = await fetch("/api/organizations/${ORG}/chat_conversations/${CONV}/completion", {
      method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({ prompt: "Plan a trip to Goa for four people. " + "x".repeat(200000), model: "claude-sonnet-5-5" }) });
    const text = await res.text();
    window.sent.push({ status: res.status, length: text.length });
  }
  document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); send(); });
  fetch("/api/organizations/${ORG}/chat_conversations/${CONV}?tree=True").then(r => r.json());
</script></body></html>`;

const USAGE_JSON = JSON.stringify({
  five_hour: { utilization: 18, resets_at: new Date(Date.now() + 3 * 3600e3).toISOString() },
  seven_day: { utilization: 25, resets_at: new Date(Date.now() + 4 * 86400e3).toISOString() },
});

async function main() {
  const health = await call("/health");
  if (!health.needs_setup) throw new Error("API database isn't empty — reset it first.");
  const { login_code } = await call("/setup", {
    method: "POST",
    body: { secret: SECRET, owner_name: "Pranav", account_name: "My Claude", plan: "max5" },
  });
  const { token: owner } = await call("/login", { method: "POST", body: { code: login_code } });
  const { code } = await call("/enroll-code", { method: "POST", token: owner, body: {} });

  const tmp = mkdtempSync(join(tmpdir(), "clare-smoke-"));
  const extDir = join(tmp, "ext");
  execFileSync(process.execPath, [join(EXT, "scripts/stage.mjs"), "--api", API, "--web", WEB, "--out", extDir]);
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--user-data-dir=${join(tmp, "profile")}`,
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] }
  );
  const c = cdp(chrome);
  try {
    const { id: extId } = await c.send("Extensions.loadUnpacked", { path: extDir });
    check("extension loads in Chrome", !!extId, extId);
    await sleep(1500);
    const { targetInfos } = await c.send("Target.getTargets");
    check("service worker running", targetInfos.some((t) => t.type === "service_worker" && t.url === `chrome-extension://${extId}/sw.js`));

    async function open(url, viewport) {
      const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
      if (viewport) await c.send("Emulation.setDeviceMetricsOverride", { ...viewport, mobile: false }, sessionId);
      return { sessionId, go: (u) => c.send("Page.navigate", { url: u }, sessionId), targetId };
    }
    const evaluate = async (s, expr) =>
      (await c.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, s)).result.value;
    async function until(s, expr, ms = 10000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const v = await evaluate(s, expr).catch(() => null);
        if (v) return v;
        await sleep(250);
      }
      return null;
    }
    async function shot(s, name) {
      if (!SHOTS) return;
      mkdirSync(SHOTS, { recursive: true });
      const { data } = await c.send("Page.captureScreenshot", { format: "png" }, s);
      writeFileSync(join(SHOTS, name), Buffer.from(data, "base64"));
    }

    // 1. Enroll page → automatic enrollment.
    const enrollTab = await open("about:blank", { width: 1100, height: 900, deviceScaleFactor: 1 });
    await enrollTab.go(`${WEB}/enroll.html#${code}`);
    const state = await until(enrollTab.sessionId, `document.querySelector('[data-enroll-code]')?.getAttribute('data-extension-state') === 'connected' && document.querySelector('[data-enroll-code]').getAttribute('data-extension-device')`);
    check("enroll page enrolls the extension automatically", !!state, String(state));
    await sleep(1200);
    await shot(enrollTab.sessionId, "enroll-connected.png");

    // 2. Popup.
    const pop = await open("about:blank", { width: 340, height: 640, deviceScaleFactor: 2 });
    await pop.go(`chrome-extension://${extId}/popup/popup.html`);
    const headline = await until(pop.sessionId, `!document.getElementById('view-paired').hidden && document.getElementById('headline').textContent`);
    check("popup shows this browser's status", headline === "Within budget", String(headline));
    await shot(pop.sessionId, "popup-ok.png");

    // 3. Fake claude.ai: every request answered locally.
    const page = await open("about:blank", { width: 1100, height: 800, deviceScaleFactor: 1 });
    const sse = readFileSync(join(EXT, "test/fixtures/api-style.sse"));
    let completionStatus = 200;
    await c.send("Fetch.enable", { patterns: [{ urlPattern: "https://claude.ai/*" }] }, page.sessionId);
    c.on(async (m) => {
      if (m.method !== "Fetch.requestPaused" || m.sessionId !== page.sessionId) return;
      const { requestId, request } = m.params;
      const url = new URL(request.url);
      let body = "";
      let type = "application/json";
      let status = 200;
      if (url.pathname.endsWith("/completion")) {
        body = sse.toString("base64");
        type = "text/event-stream";
        status = completionStatus;
      } else if (url.pathname.endsWith("/usage")) {
        body = Buffer.from(USAGE_JSON).toString("base64");
      } else if (url.pathname.includes("/chat_conversations/")) {
        body = readFileSync(join(EXT, "test/fixtures/conversation.json")).toString("base64");
      } else {
        body = Buffer.from(FAKE_PAGE).toString("base64");
        type = "text/html";
      }
      c.send("Fetch.fulfillRequest", { requestId, responseCode: status, responseHeaders: [{ name: "content-type", value: type }], body }, page.sessionId).catch(() => {});
    });
    const contexts = [];
    c.on((m) => { if (m.method === "Runtime.executionContextCreated" && m.sessionId === page.sessionId) contexts.push(m.params.context); });
    c.on((m) => { if (process.env.SMOKE_DEBUG && m.sessionId === page.sessionId && (m.method === "Runtime.exceptionThrown" || m.method === "Runtime.consoleAPICalled")) console.log("page:", JSON.stringify(m.params).slice(0, 400)); });
    await c.send("Runtime.enable", {}, page.sessionId);
    await page.go("https://claude.ai/new");
    await until(page.sessionId, `document.title === 'fake claude'`);
    await sleep(800);
    if (process.env.SMOKE_DEBUG) {
      for (const ctx of contexts) {
        const v = await c.send("Runtime.evaluate", { expression: "typeof ClareCore + '/' + typeof chrome?.runtime?.id", contextId: ctx.id, returnByValue: true }, page.sessionId).catch((e) => ({ result: { value: String(e) } }));
        console.log("ctx", ctx.id, ctx.name, JSON.stringify(ctx.auxData), v.result.value);
      }
    }
    await evaluate(page.sessionId, `window.__msgs = []; addEventListener('message', (e) => { if (e.data && e.data.__clare_v1__) __msgs.push(e.data.type + ':' + JSON.stringify(e.data.payload).slice(0, 160)); }); true`);
    await evaluate(page.sessionId, `document.querySelector('button').click(), true`);
    const sent = await until(page.sessionId, `window.sent.length && window.sent[0].status`);
    check("page's own fetch still works through the wrapper", sent === 200, String(sent));
    if (process.env.SMOKE_DEBUG) console.log("debug:", await evaluate(page.sessionId, `JSON.stringify({wrapped: !!window.fetch.__clare, core: typeof window.ClareCore, url: location.href})`));

    // usage + meter reach the API
    let me;
    const ext = () => me.devices.find((d) => d.kind === "extension" && !d.removed_at);
    for (let i = 0; i < 40; i++) {
      me = await call("/me", { token: owner });
      if (ext()?.usage.credits > 0 && me.account.meter) break;
      await sleep(250);
    }
    check("claude.ai message counted for this browser", ext()?.usage.credits > 0, `credits=${ext()?.usage.credits}`);
    if (process.env.SMOKE_DEBUG) console.log("msgs:", await evaluate(page.sessionId, `JSON.stringify(window.__msgs)`));
    check("official meter forwarded (5s after org seen)", !!me.account.meter, JSON.stringify(me.account.meter?.seven_day ?? null));

    // 4. Budget below what the meter shows → banner + send refused.
    await call("/settings", { method: "PATCH", token: owner, body: { budget_pct: 10 } });
    // The status cache is fresh (<60s), so let the popup refresh it, like opening the popup would.
    await pop.go(`chrome-extension://${extId}/popup/popup.html`);
    const blockedHeadline = await until(pop.sessionId, `document.getElementById('headline').textContent.startsWith('Budget used up') && document.getElementById('headline').textContent`);
    check("popup shows budget used up", !!blockedHeadline, String(blockedHeadline));
    await shot(pop.sessionId, "popup-blocked.png");
    await page.go("https://claude.ai/new");
    await until(page.sessionId, `document.title === 'fake claude'`);
    await sleep(1500);
    const bannerUp = await evaluate(page.sessionId, `!!document.querySelector('clare-banner')`);
    check("banner shown on claude.ai", bannerUp);
    await evaluate(page.sessionId, `window.sent = []; document.querySelector('button').click(); true`);
    await sleep(600);
    const afterClick = await evaluate(page.sessionId, `window.sent.length`);
    check("send button blocked", afterClick === 0, `sent=${afterClick}`);
    const direct = await evaluate(page.sessionId, `send().then(() => window.sent.at(-1).status)`);
    check("fetch backstop refuses completion (429)", direct === 429, String(direct));
    await shot(page.sessionId, "claude-blocked.png");
    await call("/settings", { method: "PATCH", token: owner, body: { budget_pct: 100 } });
  } finally {
    chrome.kill();
    await sleep(300);
    rmSync(tmp, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
