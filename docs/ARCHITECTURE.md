# clare architecture

clare is a cross-device manager for **one person's** Claude account. It shows the account's official weekly usage
in one place, works out which of your computers and browsers used it, enforces a weekly budget you choose at the
points clare controls (Claude Code hooks, the claude.ai Send button), and tells you when a device stops reporting
or its clare setup changes.

```
 YOUR DEVICES                                               CLOUD (free tier)
┌──────────────────────────────────┐                      ┌──────────────────────────────┐
│ clare CLI  (one Go binary)       │ ── check / report ─▶ │ Supabase Edge Function /api  │
│ managed hooks + status line:     │ ◀─ status, budget ── │   enroll · check · report    │
│   prompt   → check budget        │                      │   meter · heartbeat · alerts │
│   tool use → mid-turn check      │ ── heartbeat 5 min ▶ │                              │
│   stop     → exact token count   │                      │ Postgres                     │
│   status line → official meter % │                      │   settings · devices         │
│ watchdog   → heartbeat, drift    │                      │   usage · meter readings     │
│ (every terminal, VS Code,        │                      │   alerts · codes             │
│  JetBrains, desktop app)         │                      └──────────────┬───────────────┘
├──────────────────────────────────┤                                     │
│ clare extension  (Chrome MV3)    │ ── usage, meter %, heartbeat ──────▶│
│   claude.ai: meters replies,     │                                     │
│   holds Send when over budget    │                                     ▼
└──────────────────────────────────┘                      ┌──────────────────────────────┐
  phone app, other browsers,                              │ clare web  (GitHub Pages)    │
  claude.ai/code ── not enrolled ──▶ "unobserved usage"   │   enroll.html · dash.html    │
                                                          │   install.sh · install.ps1   │
                                                          └──────────────────────────────┘
```

## Repo layout

| Path | What |
|---|---|
| `clare.config.json` | Deployment config: `apiUrl`, `webUrl`, `releasesUrl`, `extensionUrl`. Filled by `scripts/setup.sh`. |
| `supabase/migrations/` | Postgres schema. |
| `supabase/functions/_shared/core.ts` | Pure logic: rates, credits, meter attribution, budgets, status copy. Runs in Deno and Node. |
| `supabase/functions/_shared/app.ts` | HTTP handler `createApp({ sql, setupSecret, now })` + DB queries (postgres.js). |
| `supabase/functions/api/index.ts` | `Deno.serve(handle)`. |
| `scripts/dev-server.ts` | Runs the same handler in Node against a local Postgres; serves `web/`. |
| `cli/` | Go module, stdlib only. Single static binary `clare`. |
| `extension/` | Chrome MV3 extension, no build step. |
| `web/` | Static site: `index.html`, `enroll.html`, `dash.html`, `bye.html`, `install.sh`, `install.ps1`. |
| `scripts/build.mjs` | Injects config, builds `dist/web`, `dist/extension` (+zip), `dist/bin/*`. |

## Config injection

Source files use placeholders replaced by `scripts/build.mjs` (and by the dev server for `web/`):

| Placeholder | Example |
|---|---|
| `__CLARE_API_URL__` | `https://abcd.supabase.co/functions/v1/api` |
| `__CLARE_WEB_URL__` | `https://you.github.io/clare` (no trailing slash) |
| `__CLARE_RELEASES_URL__` | `https://github.com/you/clare/releases/latest/download` |

- web: `web/config.js` sets `window.CLARE = { apiUrl, webUrl, releasesUrl, extensionUrl }`. `?api=http://localhost:8787`
  overrides `apiUrl` for local dev (remembered in localStorage).
- extension: `extension/config.js` exports `CONFIG = { apiUrl, webUrl }`; `manifest.json` has `__CLARE_WEB_URL__/*`
  in a content_scripts match and the API origin in host_permissions. Unreplaced placeholders fall back to localhost.
- CLI: `clare enroll <code> --api <url> --web <url>`; `install.sh` passes both. Stored in the CLI config.
  Defaults can be baked in with `-ldflags "-X main.defaultAPI=... -X main.defaultWeb=..."`.

## Model

- **Account**: one row (`clare_settings`). Owner name, account name, plan, weekly **budget**, warn level,
  `enforce` (block vs. monitor only), `strict_hooks`, the latest official meter reading.
- **Devices**: `cli` (Claude Code on a computer), `extension` (a Chrome profile), `web` (a signed-in dashboard
  session, never listed or metered). All belong to the owner.
- **Admin devices**: only devices with `admin` on can change things: settings, budget, caps, adding (minting
  enroll codes) and removing devices, dismissing alerts. Everything else gets `403 admin_only`. Other devices
  report usage, check the budget, remove themselves (`clare uninstall`) and open a **view-only** dashboard.
  A dashboard session copies the flag from what signed it in: `scripts/setup.sh` / `/recover` → admin;
  `/login-link` → the calling device's flag. New devices are admin only when their enroll code was minted with
  `admin: true`; re-enrolling a machine keeps its flag. The setup secret always gets you an admin dashboard, so
  you can't lock yourself out.
- **Enrollment codes**: short codes the dashboard mints to add a device. Valid **7 days**, any number of devices,
  stored hashed, with an `admin` flag. A code can be limited to one `kind`: any device (even a non-admin one)
  may mint a one-hour, browser-only code for itself (`clare browser`); its admin flag can't exceed the caller's.
- **Usage events**: one per Claude reply, tokens by model (exact from Claude Code transcripts, estimated from text
  on claude.ai). Idempotent on `key` across the whole account.
- **Meter readings**: the official weekly (and 5-hour) usage %, as seen by any device.
- **Alerts**: things that need your attention (see below).

### Points

**1 point = 1% of the account's official weekly limit.** Budgets, usage and attribution are all in points.

- `budget_pct` (account, 1–100, default 100): the weekly budget. At 90 clare blocks once the week is 90% used,
  leaving 10% in reserve.
- `warn_pct` (account, 10–99, default 80): warn when usage reaches this % *of the budget*.
- Device cap `budget_pct` (per device, optional, 0.5–100 points): this device may use at most this many points per
  week, whatever the account total is.
- `enforce` (default on): off = monitor only. Nothing is ever blocked; over-budget shows as state `over`.

## Metering: the official meter decides *how much*, activity decides *which device*

**The meter.** Claude's own weekly usage meter (what `/usage` and claude.ai → Settings → Usage show) is the ground
truth. Two places read it:

- **CLI**: Claude Code passes `rate_limits.seven_day.used_percentage` / `.resets_at` (epoch seconds) and
  `rate_limits.five_hour.*` to the **status line** after each assistant message (Pro/Max plans). clare's managed
  `statusLine` saves that reading locally and runs your own status line; hooks send the newest unsent reading
  with `/report`.
- **Extension**: reads claude.ai's usage endpoint, at most every 10 min and after each reply.

Canonical reading (all clients send this shape; the server also accepts `utilization` as an alias for `pct`):

```jsonc
{ "at": "2026-10-15T10:00:00Z",                                        // when it was read (client clock)
  "seven_day": { "pct": 41.2, "resets_at": "2026-10-19T16:00:00Z" },   // required
  "five_hour": { "pct": 23.5, "resets_at": "2026-10-15T13:00:00Z" } }  // optional
```

Server validation: `pct` finite in [0, 1000]; `seven_day.resets_at` within `(now, now + 8 d]`, otherwise the reading
is stale and dropped; `at` clamped to `[now − 1 d, now]`, default now. A reading is stored in
`clare_meter_readings` when its weekly % differs from the latest stored reading of the same week, or it starts a new
week. Every valid reading also becomes `clare_settings.meter` (shown on the dashboard, including the 5-hour window).
Readings older than 21 days are pruned.

**Activity.** Usage events are converted to **credits** (API list prices below). Credits are only weights: they
split meter increases between devices, and estimate usage the meter hasn't shown yet.

| family (substring of model id) | input | output | cache read | cache write 5m | cache write 1h |
|---|---|---|---|---|---|
| `fable` / `mythos` | 10 | 50 | 0.25 | 12.5 | 20 |
| `opus` | 4 | 20 | 0.20 | 5 | 8 |
| `sonnet` (also the fallback) | 2 | 10 | 0.20 | 2.5 | 4 |
| `haiku` | 0.10 | 0.50 | 0.01 | 0.125 | 0.20 |

**Attribution** (pure `attribute()` in core.ts, computed on read):

1. **Week.** Take the newest reading whose `resets_at` is in the future. The week is `[resets_at − 7 d, resets_at)`.
   Readings whose `resets_at` is within 1 h of it belong to this week. No such reading → **estimate** basis (below).
2. **Baseline.** If clare existed at week start: a virtual 0% reading at week start. Otherwise the first reading of
   the week; its % is reported as `before_clare` (used before clare was set up).
3. **Walk** readings in time order, keeping the running max. Credits per device from events with
   `at` in `(previous reading, this reading]` accumulate. When the meter rises by `Δ`, `Δ` is split across the
   accumulated credits in proportion and the accumulator resets. A rise with no accumulated activity is
   **unobserved**. A reading that doesn't rise leaves the accumulator alone (the meter moves in whole steps).
   Dips are ignored.
4. **Pending.** Credits still in the accumulator after the last reading aren't in the meter yet. They're estimated
   as `credits × points_per_credit`, where `points_per_credit` = this week's attributed Δ ÷ attributed credits
   (needs ≥ 1 attributed point; otherwise `100 / capacity`).

Results: account `used` = running max + pending; per device `used` = attributed + pending; `unobserved` and
`before_clare` for the account. `basis: "meter"`.

**Estimate basis** (no reading this week, e.g. only API-key usage, or no device has seen the meter yet): week =
7-day window aligned to `week_anchor` (the last known reset, initially setup time); device `used` =
`credits × 100 / capacity`; account `used` = Σ devices. `basis: "estimate"`, and all copy says "about".
`capacity` (credits per week) = `capacity_manual` ?? `capacity_calibrated` ?? plan default
(pro 60, max5 300, max20 1200). Calibration, at most every 10 min when a reading arrives and the week has
≥ 5 attributed points: `implied = attributed credits ÷ attributed points × 100`, blended 70/30 with the previous value.

## Status object (returned by /check, /report, /heartbeat, /enroll; `status` inside /me)

```jsonc
{
  "allowed": true,                 // false only when state is "blocked"
  "state": "ok",                   // "ok" | "warn" | "over" (over budget, enforcement off) | "blocked"
  "basis": "meter",                // "meter" | "estimate"
  "scope": "account",              // which budget used/limit/pct describe: "account" | "device"
  "used": 41.6,                    // points
  "limit": 90,                     // points
  "pct": 46.2,                     // used / limit × 100, can exceed 100
  "account": { "used": 41.6, "budget": 90, "pct": 46.2 },
  "device": { "id": "uuid", "label": "MacBook Air", "used": 12.3, "budget": 30, "pct": 41 },
                                   // null for dashboard sessions; budget and pct are null without a device cap
  "resets_at": "2026-10-19T16:00:00.000Z",
  "enforce": true,
  "strict_hooks": false,
  "title": "46% used",             // short, for badges
  "message": "You've used 46% of this week's Claude budget."
}
```

`scope` is whichever of account / device cap has the higher `pct` (account on ties or without a cap).
State: `pct ≥ 100` → `blocked` (or `over` when `enforce` is off); `pct ≥ warn_pct` → `warn`; else `ok`.
Clients send `X-Clare-TZ: <IANA tz>` so times in messages are local. Copy, with `<budget>` = "this week's Claude
budget" (account scope) or "<label>'s weekly budget" (device scope), "about" inserted on estimate basis:

- ok: `You've used 46% of this week's Claude budget.`
- warn: `Heads up: you've used 85% of this week's Claude budget. It resets on Monday at 9:30 PM.`
- blocked: `You've used all of this week's Claude budget. It resets on Monday at 9:30 PM. You can change the budget in the clare dashboard.`
  Device scope: `MacBook Air has used all of its weekly budget. It resets on Monday at 9:30 PM. You can change it in the clare dashboard.`
- over: `You're over this week's Claude budget (monitor only, nothing is blocked). It resets on Monday at 9:30 PM.`
- titles: `46% used` (ok, warn), `Budget used up` (blocked), `Over budget` (over).

## Enforcement and the cached-policy strategy

clare enforces only where it runs: Claude Code on enrolled computers (hooks) and claude.ai in Chrome profiles with
the extension. A device that isn't enrolled, or a client that skips the hooks, is neither monitored nor blocked; its
usage shows up only as **unobserved**.

- Clients cache the last status and when they got it.
- **Online**: block exactly when `state == "blocked"`.
- **Offline** (network error or timeout): use the cache. Block only if the cached state is `blocked`, the cached
  `resets_at` is still in the future, and the cache is less than **24 h** old. Otherwise allow.
- Never block because the server is unreachable, a token is rejected (`401`), or local config is missing. Those are
  health problems: the CLI says so once per session and `clare doctor` explains; the watchdog reports them.
- `410 revoked` (device removed from the dashboard): stop enforcing, say "This device was removed from clare" once.
  The CLI watchdog uninstalls clare; the extension unpairs.
- Usage that couldn't be sent is sent later (CLI: transcript offsets; extension: a local queue).

## Health and alerts

- Heartbeat every 5 min from the CLI watchdog and the extension. `connectivity`: `removed` if removed;
  `problem` if the last heartbeat reported problems; `online` if seen in the last 12 min; else `offline`.
- `enforcement` (per device): `active` = online with no problem; `unverified` = offline or with a problem;
  `removed`. The dashboard shows unverified devices prominently: clare can't confirm their budget holds.
- The watchdog compares the managed settings drop-in and the binary against root-owned backups, restores them,
  and reports `health.ok = false` with the problems.

| kind | When | Message (example) |
|---|---|---|
| `device_enrolled` | a device enrolls | `Claude Code on MacBook Air is now connected.` |
| `device_removed` | `clare uninstall`, extension uninstalled (`/bye`) | `clare was removed from MacBook Air (Claude Code).` |
| `config_changed` | a heartbeat first reports problems | `clare's files on MacBook Air were changed (hook settings missing). It restored what it could.` |
| `device_offline` | a non-web device hasn't been seen for 48 h (checked lazily on /heartbeat and /me; auto-resolved when it's back) | `MacBook Air hasn't checked in for 2 days, so clare can't confirm its budget holds.` |
| `unobserved_usage` | this week's unobserved points grew by ≥ 1 since the last such alert (at most every 6 h) | `About 3% of this week's limit was used where clare couldn't see it: the phone app, another browser, claude.ai/code, or a computer without clare.` |

Heartbeats return new unresolved alerts since that device's last heartbeat, excluding alerts about the device itself,
so the extension can show notifications.

## HTTP API

Base: `apiUrl`. JSON in/out. CORS `*`. Auth: `Authorization: Bearer <device token>` (`clr_…`).
Errors: `{ "error": "<code>", "message": "<human text>" }`. `401 unauthorized` = unknown token.
`410 revoked` = this device was removed.

### Public

| Method & path | Body | Response |
|---|---|---|
| `GET /health` | – | `{ ok: true, needs_setup, version }` |
| `POST /setup` | `{ secret, owner_name, account_name, plan }` | `{ login_code }` — only once; `secret` must equal env `CLARE_SETUP_SECRET`. |
| `GET /enroll/:code` | – | `{ account_name, owner_name, admin, kind, expired, devices: [{ kind, label, created_at, last_seen_at }] }` — devices enrolled with this code; the enroll page polls it. `404 invalid_code`. |
| `POST /enroll` | `{ code, kind: "cli"\|"extension", label, info }` | `{ token, device_id, bye_secret, status }`. Re-enrolling the same machine (`info.machine_id`, same kind) replaces the old device and moves its history over. `410 expired_code`. |
| `POST /login` | `{ code }` | `{ token, admin }` — one-time login code (10 min) → `web` device token with the code's admin flag. |
| `POST /bye` | `{ device_id, secret }` | `{ ok }` — extension uninstall ping from `bye.html`. |
| `POST /recover` | `{ secret }` | `{ login_code }` — lost dashboard link; needs the setup secret (`.clare-secret`). |

### Device-authenticated

| Method & path | Body | Response |
|---|---|---|
| `POST /check` | `{}` | `{ status }` |
| `POST /report` | `{ events: [{ key, model, input, output, cache_read, cache_write, cache_write_1h, at, estimated }], meter?: <reading> }` (≤ 500 events) | `{ accepted, status }` — dashboards get 403. |
| `POST /meter` | `<reading>` | `{ ok, stored }` |
| `POST /heartbeat` | `{ info: {...}, health: { ok, problems: [string] } }` | `{ status, settings: { enforce, strict_hooks }, alerts: [{ id, kind, message, created_at }] }` |
| `POST /device/remove` | `{ reason }` | `{ ok }` — the device removes itself (`clare uninstall`). |
| `POST /login-link` | `{}` | `{ code, expires_at }` → open `webUrl/dash.html#login=<code>` (admin only if the caller is) |
| `POST /enroll-code` | `{ admin?: boolean, kind?: "cli" \| "extension" }` | `{ code, admin, kind, expires_at }` → `webUrl/enroll.html#<code>` · **admin**, except `kind: "extension"` (1 h, admin only if the caller is). `POST /enroll` with the wrong kind → `403 wrong_kind`. |
| `GET /me` | – | dashboard payload (below) |
| `PATCH /devices/:id` | `{ label?, budget_pct?: number \| null, admin?: boolean }` | `{ ok }` · **admin** |
| `DELETE /devices/:id` | – | `{ ok }` — revoke; the device gets `410` next time. · **admin** |
| `POST /alerts/:id/resolve` | – | `{ ok }` · **admin** |
| `PATCH /settings` | `{ account_name?, owner_name?, plan?, capacity_manual?, budget_pct?, warn_pct?, enforce?, strict_hooks? }` | `{ ok }` · **admin** |

### `GET /me`

```jsonc
{
  "me": { "device_id": "…", "kind": "web", "admin": true },   // the caller; admin = can change things
  "account": {
    "name": "My Claude", "owner_name": "Pranav", "plan": "max5",
    "budget_pct": 90, "warn_pct": 80, "enforce": true, "strict_hooks": false,
    "basis": "meter",
    "capacity": { "value": 300, "source": "plan" | "calibrated" | "manual" },
    "week": { "start": "…", "resets_at": "…" },
    "meter": { "seven_day": { "pct": 41, "resets_at": "…" }, "five_hour": { "pct": 23.5, "resets_at": "…" } | null,
               "at": "…", "device_label": "MacBook Air" } | null,
    "used": 41.6,          // points: official meter + pending estimate (or Σ estimate)
    "observed": 30.2,      // attributed to enrolled devices
    "unobserved": 3.1,
    "before_clare": 8,
    "pending": 0.6
  },
  "status": { /* status for the caller; device = null for dashboards */ },
  "devices": [             // active first, then removed in the last 14 days; never web, never replaced
    { "id": "…", "kind": "cli", "label": "MacBook Air", "os": "macOS", "browser": null,
      "connectivity": "online", "enforcement": "active", "problem": null,
      "last_seen_at": "…", "created_at": "…", "removed_at": null,
      "admin": true, "budget_pct": 30,
      "usage": { "points": 12.3, "credits": 18.2, "by_model": { "opus": 15.1, "sonnet": 3.1 } } }
  ],
  "alerts": [ { "id": 1, "kind": "device_offline", "message": "…", "created_at": "…", "device_id": "…", "device_label": "…" } ],
  "daily": [ { "date": "2026-10-14", "device_id": "…", "credits": 4.2 } ]     // last 14 days, in X-Clare-TZ
}
```

## CLI (`cli/`, Go, stdlib only)

Install (from the enroll page): `curl -fsSL <webUrl>/install.sh | sh -s -- <code>` → downloads
`clare-<os>-<arch>` from `releasesUrl` → `sudo clare enroll <code> --api <apiUrl> --web <webUrl>`.
Windows: `irm <webUrl>/install.ps1 | iex` with `$env:CLARE_CODE` (self-elevates via UAC).

Files (system dir = `/Library/Application Support/ClaudeCode` | `/etc/claude-code` | `C:\Program Files\ClaudeCode`):
- `<sys>/clare/clare` (root-owned 755) + symlink `/usr/local/bin/clare`
- `<sys>/clare/config.json` (root-owned 644): `{ api, web, token, device_id, label, machine_id }`
- `<sys>/managed-settings.d/50-clare.json` (root-owned 644): hooks (exec form, absolute path), `statusLine`, and
  `allowManagedHooksOnly` only when `strict_hooks` is on (off by default: blocking works without it, and it turns
  off your own hooks and plugins)
- `<sys>/clare/.backup/` (root 700): copies + sha256 for the watchdog
- `<sys>/clare/extension/` (root-owned, readable): the browser extension, bundled into the binary by
  `scripts/build.mjs` (`cli/ext`, `go:embed`), for "Load unpacked"; `extension.sum` records which version is there
- per-user state: `~/Library/Caches/clare` | `~/.cache/clare` | `%LOCALAPPDATA%\clare` — transcript offsets,
  cached status, latest meter reading

Hooks (`clare hook <event>`; JSON on stdin; never crash; always exit 0):
- `SessionStart` → flush + check, cache status; warn/blocked → `systemMessage`.
- `UserPromptSubmit` → flush unreported usage, `/report` with the newest unsent meter reading (3 s timeout);
  blocked → `{"decision":"block","reason":<message>}`; warn/over → `{"systemMessage":"clare: …"}` once per session.
- `PreToolUse` → if the cached status blocks → deny (`hookSpecificOutput.permissionDecision: "deny"`,
  `continue: false`). Every ≥ 30 s: flush + `/report` (2 s timeout) so a long agent run stops mid-turn.
- `Stop`, `SubagentStop`, `SessionEnd` → flush + `/report`.
- Blocking follows the cached-policy strategy above.

Transcripts: `message.usage` on `type:"assistant"` lines; the same `message.id` repeats across lines with identical
usage → count once. Subagents: `<transcript dir>/<session_id>/subagents/*.jsonl`. Event `key` = message id.

**Status line** (`clare statusline`, the managed `statusLine`): reads the status-line JSON on stdin, saves
`rate_limits` as a canonical reading in the user state dir, then runs your own `statusLine.command` from
`~/.claude/settings.json` or the project's `.claude/settings.json` / `.claude/settings.local.json` (project dir from
`workspace.project_dir`, else `cwd`) with the same stdin, never itself, prints its output, and adds one short line:
`clare · 46% of weekly budget`. No network, ≤ 1 s for clare's own work, never fails.

Watchdog (`clare watchdog`, root, every 5 min via launchd / systemd timer / scheduled task): verify drop-in +
binary against backup (restore + report problems), refresh the extension folder when the binary carries a newer
one (browsers load unpacked extensions from disk at startup, so they update on their next restart), `/heartbeat`,
apply `strict_hooks` changes, self-uninstall on `410 revoked`.

**Profiles** — managed settings reach every Claude Code profile on a computer (each `CLAUDE_CONFIG_DIR`, e.g.
clauth's `~/.clauth/profiles/<name>/runtime-*`), which may be signed in to other Claude accounts. A computer can be
limited to some: `sudo clare enroll <code> --profile pranav` or `sudo clare profile pranav` (`--all` undoes it),
stored as `profiles` in the config. A name matches `…/profiles/<name>/…` or a config dir named that; a path matches
that dir and below; `default` is `~/.claude`. In other profiles hooks exit silently (no report, no block) and the
status line shows only your own line and never saves that profile's meter reading.

Commands: `enroll`, `browser`, `profile`, `status`, `dashboard` (opens dash via `/login-link`), `doctor`, `uninstall`,
`version`, `hook`, `statusline`, `watchdog`.

**Browser guide** — `enroll` ends with it (unless `--no-browser`), and `clare browser` runs it alone with a fresh
browser-only code. It finds the Chromium browsers installed (Chrome, Edge, Brave, Arc, Vivaldi, Opera, Chromium) and
goes through them one at a time: open that browser's extensions page (`chrome://extensions`, `edge://extensions`,
`brave://extensions`, …), say where its Developer mode switch is, show the extension folder in Finder / Explorer and
copy its path, wait for Enter (`s` skips a browser, `q` stops), then open `webUrl/enroll.html#<code>` in that
browser so the extension enrolls itself, and poll `GET /enroll/:code` until a new extension device appears (90 s;
otherwise it prints the code to paste into the popup). Answers are read from the terminal (`/dev/tty`), so it works
under `curl … | sh`; with no terminal it prints every browser's steps at once. Under sudo, browsers and Finder open
as the signed-in user; an elevated Windows session never starts a browser and prints the steps instead. A build
without the bundled extension points at the enroll page's download instead.

## Extension (`extension/`, Chrome MV3, no build step)

- Fixed ID `hjhfkchlbpmpehebaehgeljcpdknlmbn`: `manifest.json` carries the public `key` (the private key is the
  owner's git-ignored `.clare-extension-key.pem`, for a same-ID Web Store upload).
- Pairing: (1) content script on `webUrl/enroll.html` reads `<main data-enroll-code>` and enrolls; (2) popup
  fallback: paste the enroll link or code.
- claude.ai: a MAIN-world script wraps `fetch` to observe completions (SSE) and conversation loads, estimates
  tokens, reports usage; reads the official meter at most every 10 min and after each reply; sends readings in the
  canonical shape; holds Send (Enter/click intercept + fetch backstop) per the cached-policy strategy, with a banner.
- Heartbeat every 5 min (`chrome.alarms`). `chrome.runtime.setUninstallURL(webUrl/bye.html#d=<id>&s=<secret>)`.
- Notifications: when this browser's status turns `warn` or `blocked`, and for alerts returned by heartbeats.
- Popup: a ring with "% of weekly budget used", "resets Monday 9:30 PM", basis (official meter / estimate), this
  device's cap if set, connection state, "Open dashboard".

## Web (`web/`, static, no framework)

- `enroll.html#<code>` — "Add a device to clare". Pick Claude Code and/or the browser; OS-detected one-line command
  with Copy; "Add to Chrome" (Web Store when `extensionUrl` is set, else the zip with load-unpacked steps); live ticks
  as devices enroll.
- `dash.html` — overview (official meter, budget bar, basis, reset time, 5-hour window, unobserved and before-clare
  points), devices (connectivity, enforcement, usage, cap, admin, rename, remove), "Add a device" (mints an enroll
  link, optionally for admin devices), alerts, last-14-days chart by device, settings (names, plan, budget, warn
  level, enforce, strict hooks, capacity). Non-admin sessions see the same data, view-only.
- `bye.html#d=…&s=…` — "clare was removed from this browser" + pings `/bye`.
- `index.html` — what clare is, link to the dashboard.

## Privacy

Only numbers and device metadata leave a computer: token counts, model names, timestamps, meter percentages, device
names, OS and browser names. Never prompts, responses, file contents, or conversation titles.
