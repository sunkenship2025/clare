# clare — Chrome extension

The browser half of clare. On claude.ai it reports how much each reply used, forwards Claude's
official weekly usage meter, shows where you are against the weekly budget you set, and holds
Send once that budget is used up. Works in Chrome, Edge, Brave and other Chromium browsers (Chrome 116+).

| File | What it does |
|---|---|
| `manifest.json` | MV3 manifest. Contains URL placeholders — see below. |
| `config.js` | `CLARE_CONFIG = { apiUrl, webUrl }` (placeholders, localhost fallback). |
| `sw.js` | Service worker: enrollment, status cache, usage queue + retries, heartbeat (5 min), meter readings, notifications, uninstall URL. |
| `lib/core.js` | Pure helpers (estimates, meter parsing, the blocking rule, status → words, enroll links). Used by the worker, popup, claude.ai content script, tests. |
| `lib/page.js` | Pure helpers that run *inside* claude.ai's page: URL matchers, SSE parser, size counting. |
| `content/inject.js` | MAIN world on claude.ai: wraps `fetch` to observe completions + conversation loads, refuses completions while blocked. |
| `content/claude.js` | Isolated world on claude.ai: estimates usage, reports it, reads the official usage meter, shows the banner, stops Enter/Send while blocked. |
| `content/enroll.js` | On the enroll page: connects this browser automatically. |
| `popup/` | The popup: budget ring, this week's numbers, connection state, dashboard link, enrollment. |
| `icons/` | Ring glyph. Regenerate with `node extension/scripts/make-icons.mjs`. |

`lib/page.js` and `lib/core.js` are separate on purpose: Chrome injects a given file only once
per frame, so a file listed for both the MAIN and isolated worlds silently goes missing from one.

## Local development

1. Run the API and web locally (repo root): `scripts/dev-db.sh start` then `node scripts/dev-server.ts`
   (API on `http://localhost:8787`, web on `http://localhost:8788`).
2. Stage a loadable copy — Chrome refuses a manifest with unreplaced match patterns:
   ```sh
   node extension/scripts/stage.mjs            # → extension/.dev-build, pointed at localhost
   node extension/scripts/stage.mjs --api http://localhost:8793 --web http://localhost:8794 --out /tmp/clare-ext
   ```
3. `chrome://extensions` → Developer mode → **Load unpacked** → pick the staged folder.
   Re-run the stage script and hit ↻ after editing.

`config.js` falls back to `http://localhost:8787` / `http://localhost:8788` when its placeholders
are unreplaced, so the worker, popup and content scripts also work from a partly-filled copy.

## Placeholders (filled by `scripts/build.mjs`)

| Placeholder | Where | Example |
|---|---|---|
| `__CLARE_API_URL__` | `config.js` | `https://abcd.supabase.co/functions/v1/api` |
| `__CLARE_API_ORIGIN__` | `manifest.json` host_permissions | `https://abcd.supabase.co` |
| `__CLARE_WEB_URL__` | `config.js`, `manifest.json` (enroll-page match + host permission) | `https://you.github.io/clare` |

The packaged zip should leave out `test/`, `dev/`, `scripts/`, `README.md`, `.dev-build/`.

## Enrolling

1. **Enroll page** (`webUrl/enroll.html#<code>`, from the dashboard's *Add a device*): `content/enroll.js`
   reads the code from `<main data-enroll-code>` (it waits if the page fills it in later) and enrolls.
2. **Popup**: paste the enroll link or the bare code.

A browser that is already enrolled with this clare server, and whose token still works, isn't
enrolled again: every code belongs to the same account, so there's nothing to switch.

The enroll page hears back through attributes on the same element (content-script objects aren't
visible to page scripts):

| Attribute | Meaning |
|---|---|
| `data-extension-installed="1"` | The extension is present. |
| `data-extension-state` | `connecting` · `connected` · `error` |
| `data-extension-device` | (`connected`) This browser's device name, e.g. `Chrome on Mac`. |
| `data-extension-error` | (`error`) A friendly message to show. |

Every change also fires a bubbling `clare:extension-<state>` event (`clare:extension-installed` first).
On first install the worker reloads any open enroll tab, so "Add to Chrome → come back" just works.

## Blocking (the cached-policy rule)

Send is held back only when the last status from the server says `blocked`, its week hasn't reset,
and it is less than 24 hours old (`ClareCore.isBlocking`). `over` (over budget with enforcement
turned off) never blocks. A network error, an unknown token (`401`) or a stale cache never blocks.
`410` (this browser was removed in the dashboard) forgets the token, stops blocking, and the popup
says so.

Blocking intercepts Enter and the Send button and, as a backstop, refuses the completion request
itself (HTTP 429), so a claude.ai UI change can't let a send slip through.

## Notifications

- When this browser's status turns `warn`, `over` or `blocked`: once per state per week.
- Alerts that heartbeats return (another device enrolled, removed, offline, changed; unobserved
  usage). The server leaves out alerts about this browser itself.

## Privacy

Only numbers leave the browser: estimated token counts, the model name, a message id, the official
weekly/5-hour usage %, and the browser and OS names. **Message text, prompts, files and conversation
titles never leave the browser**: `inject.js` measures lengths in the page and passes on sizes only.
Nothing is sent to anyone except your own clare server.

## How usage is estimated

claude.ai doesn't expose token counts, so per message (`lib/core.js → estimateEvent`):

- input = new prompt + attachment text ÷ 4
- cache_read = known conversation so far ÷ 4 + 2,000 (claude.ai's system prompt)
- output = response text incl. thinking and tool input ÷ 4

If a stream ever carries real `usage` numbers, those are used instead (`estimated: false`).
These estimates are only weights: the official meter decides how much of the weekly limit was used,
and the estimates decide which device used it.

Meter readings go to `POST /meter` in the canonical shape
`{ at, seven_day: { pct, resets_at }, five_hour?: { pct, resets_at } }`.

## Known limits

- The Claude phone and desktop apps, other browsers, private windows and claude.ai/code can't be seen
  by this extension. The dashboard shows that as unobserved usage when the official meter moves
  without any enrolled device reporting.
- Uninstalling the extension pings the server (`bye.html`) and shows up as an alert.
- **Unverified claude.ai internals** (built defensively; check against the live site):
  completion URL `…/chat_conversations/<id>/(completion|retry_completion)` with a JSON body
  (`prompt`, `model`, `attachments[].extracted_content`, `turn_message_uuids`); SSE events in
  Messages-API shape (or legacy `{type:"completion"}`); `message_limit` payloads; conversation
  loads as `GET …/chat_conversations/<id>?…` with `chat_messages` + `current_leaf_message_uuid`;
  and the usage endpoint `GET /api/organizations/<org>/usage` →
  `{ five_hour: {utilization, resets_at}, seven_day: {utilization, resets_at} }` (percent).
  Unknown shapes fail quietly; the meter backs off for 6h after a failure.

## Tests

```sh
node --test extension/test                                  # unit + manifest (no network)
CLARE_TEST_API=http://localhost:8787 node --test extension/test/integration.test.mjs
node extension/dev/smoke.mjs --api http://localhost:8787 --web http://localhost:8788 --shots /tmp/shots
```

The integration test runs the real `sw.js` in Node with a fake `chrome` against a live API with an
**empty** database. The smoke test loads the extension into real (headless) Chrome over the
DevTools pipe, enrolls it from the real enroll page, then fakes claude.ai with request interception:
nothing is sent to the real claude.ai.
