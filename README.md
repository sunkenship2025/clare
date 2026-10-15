# clare

**One picture of your Claude usage across every computer and browser you use, and a weekly budget that holds
everywhere clare runs.**

You use Claude Code on a work laptop, a home desktop and a server, and claude.ai in a couple of Chrome profiles.
They all draw on the same weekly limit, and no single screen tells you which of them used it or how close you are.
clare puts Claude's official weekly meter on one dashboard, splits it by device, stops new work when you hit the
budget you set, and tells you when a device stops reporting or its setup changes.

```
Weekly limit  ████████████████████░░░░░░░░░░░░░░░░░░░░  41% of 90% budget · resets Mon 9:30 PM
  Work Mac       ██████████  18%   active
  ThinkPad       █████        9%   unverified · last seen 3 h ago
  Chrome         ███          6%   active
  before clare   ██           5%
  unobserved     █            3%   phone app, other browsers, claude.ai/code
```

## What it does

- **Official usage, centrally.** Reads Claude's own weekly (and 5-hour) usage meter from Claude Code's status line
  and from claude.ai, and keeps the reset time in sync with Anthropic's.
- **Usage by device.** Attributes each rise in the meter to the devices that were active, weighted by the tokens they
  used. What no enrolled device explains is shown as **unobserved**.
- **A weekly budget.** Block at, say, 90% of the weekly limit to keep a reserve, warn at 80% of that, and optionally
  cap a single device. Or run monitor-only.
- **Claude Code integration.** A system-wide managed hook checks the budget before each prompt and every 30 s during
  long agent runs, counts tokens exactly from transcripts (subagents included), and adds a line to your status line.
  Works in every terminal, VS Code, JetBrains and the desktop app.
- **claude.ai integration.** A Chrome extension meters replies, reads the meter, shows a ring in the toolbar, and holds
  the Send button when you're over budget.
- **Admin devices.** Only devices you mark as admin can change the budget, caps or settings, or add and remove
  devices. A server or shared machine reports usage and gets a view-only dashboard.
- **Device health.** Heartbeats every 5 minutes. You're alerted when a device goes quiet for 2 days, when clare's
  managed files change (they're restored from root-owned backups), or when clare is uninstalled.
- **Free to run.** Supabase free tier for the backend, GitHub Pages and Releases for the dashboard and downloads.

## How it works

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
├──────────────────────────────────┤                      │   alerts · codes             │
│ clare extension  (Chrome MV3)    │ ── usage, meter % ─▶ └──────────────┬───────────────┘
│   claude.ai: meters replies,     │                                     │
│   holds Send when over budget    │                                     ▼
└──────────────────────────────────┘                      ┌──────────────────────────────┐
  phone app, other browsers,                              │ clare web  (GitHub Pages)    │
  claude.ai/code ── not enrolled ──▶ "unobserved usage"   │   enroll · dashboard         │
                                                          └──────────────────────────────┘
```

### Usage accounting

The official weekly meter is the truth for **how much** of the limit is gone. Locally observed tokens only decide
**which device** it went to, and estimate the bit the meter hasn't shown yet:

- When the meter rises from 24% to 26%, those 2 points are split between the devices active since the last reading,
  in proportion to their token usage (priced at API list rates, so an Opus agent run weighs more than a Haiku reply).
- A rise with no clare activity behind it is **unobserved**: the phone app, another browser, claude.ai/code, or a
  computer without clare.
- Usage since the last reading is estimated at this week's observed rate and labelled as such.
- With no meter reading this week (for example API-key-only Claude Code), clare falls back to an estimate from your
  plan's capacity, self-calibrated from earlier weeks, and every number says "about".
- Duplicate reports, retries, late reports and meter dips are handled; nothing is counted twice.

### Enforcement

clare enforces only where it runs, and says so:

| Where Claude is used | Measured | Budget enforced |
|---|---|---|
| Claude Code on an enrolled computer (any terminal, VS Code, JetBrains, desktop app) | exactly | yes, including mid-run |
| claude.ai in a Chrome / Edge / Brave / Arc profile with the extension | estimated | yes |
| Phone apps, other browsers, claude.ai/code, computers without clare | no | no; shows up as unobserved |

- Offline, clients use their last known status: they block only if it said "blocked", the week hasn't reset, and it's
  less than 24 h old. clare never blocks just because its server is unreachable.
- Devices that haven't checked in recently, or report changed files, are marked **unverified** on the dashboard:
  clare can't confirm their budget holds.
- Removing a device on the dashboard revokes it; its watchdog uninstalls clare within 5 minutes.
- With admin rights you can always remove clare. It's a guard rail for yourself, not a lock.

### Privacy

Only numbers and device metadata leave a computer: token counts, model names, timestamps, meter percentages, device
names, OS and browser names. Never prompts, responses, file contents or conversation titles.

## Set it up (once, ~5 minutes)

You need free accounts on [Supabase](https://supabase.com) and [GitHub](https://github.com), plus `node`, `git`, `gh`,
`openssl` and `curl`.

```sh
git clone https://github.com/<you>/clare && cd clare
scripts/setup.sh
```

It creates the Supabase project, deploys the backend, publishes the dashboard and downloads to your GitHub, asks your
name and plan, and opens your dashboard. Then click **Add a device** and open that link on each computer:

- **Claude Code**: paste the one-line command it shows (macOS, Linux, Windows). It asks for your password once to
  install the managed hook system-wide.
- **claude.ai**: right after Claude Code, the same command walks you through each browser on that computer:
  it opens the browser's extensions page, tells you where Developer mode is, and has the extension folder ready
  to load. On a computer without Claude Code, the enroll page has the download. `clare browser` adds a browser later.

Lost the dashboard link? `scripts/setup.sh login`, `clare dashboard` on any enrolled computer, or "Open dashboard" in
the extension.

**Optional:** publish the extension to the Chrome Web Store as *unlisted* (one-time $5 developer fee). Upload
`dist/clare-extension.zip` from the release, put the store URL in `clare.config.json` → `extensionUrl`, and push a new
tag. Until then the enroll page offers the zip with load-unpacked steps.

Several Claude Code profiles on one computer, signed in to different accounts (for example with clauth)? Limit clare
to yours with `sudo clare profile pranav`; the others aren't tracked or limited.

On a computer, `clare status` shows where you stand, `clare doctor` checks (and with `sudo` repairs) the install, and
`sudo clare uninstall` removes it.

## Develop

```sh
npm install
scripts/dev-db.sh start              # throwaway Postgres on :54329 with the schema
node scripts/dev-server.ts           # API on :8787, website on :8788
npm test                             # backend + extension tests (needs dev-db)
(cd cli && go test ./...)            # CLI tests
node scripts/build.mjs               # dist/: site, extension zip, binaries
```

Create a local account: `curl -X POST localhost:8787/setup -H 'content-type: application/json'
-d '{"secret":"dev-secret","owner_name":"You","plan":"max5"}'`, then open
`http://localhost:8788/dash.html#login=<login_code>`. Load `extension/` unpacked in Chrome for the extension (it points
at localhost when unbuilt).

| Path | What |
|---|---|
| `clare.config.json` | Deployment config (API, web, releases, extension URLs) |
| `supabase/migrations/` | Postgres schema |
| `supabase/functions/_shared/core.ts` | Pure logic: credits, meter attribution, budgets, status copy |
| `supabase/functions/_shared/app.ts` | HTTP handler and database operations |
| `supabase/functions/api/index.ts` | Edge Function entry point |
| `cli/` | Go binary: enroll, hooks, status line, watchdog, status, doctor, uninstall |
| `extension/` | Chrome MV3 extension |
| `web/` | Static site: enroll page, dashboard, install scripts |
| `scripts/` | setup, dev server, build |

Full contract: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Credits

Enforcing limits through Claude Code managed hooks, a watchdog and root-owned files comes from
[claude-code-limiter](https://github.com/howincodes/claude-code-limiter) by Basha (MIT). clare is a rewrite:
meter-based accounting, per-device attribution, claude.ai coverage, device health, and a dependency-free binary.

clare is not affiliated with or endorsed by Anthropic. MIT licensed, see [LICENSE](LICENSE).
