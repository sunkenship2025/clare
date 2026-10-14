// node --test extension/test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const here = (p) => new URL(p, import.meta.url);
function load(file) {
  const mod = { exports: {} };
  new Function("module", "globalThis", readFileSync(here(file), "utf8"))(mod, {});
  return mod.exports;
}
const C = { ...load("../lib/page.js"), ...load("../lib/core.js") };

const ORG = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
const CONV = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
const BASE = `https://claude.ai/api/organizations/${ORG}/chat_conversations/${CONV}`;

function runSse(text, splitAt) {
  const acc = C.createCompletionAccumulator();
  const p = C.createSseParser(acc.onEvent);
  if (splitAt === undefined) p.push(text);
  else for (let i = 0; i < text.length; i += splitAt) p.push(text.slice(i, i + splitAt));
  p.end();
  return acc.result();
}

test("URL matchers", () => {
  assert.deepEqual(C.matchCompletion(`${BASE}/completion`, "POST"), { org: ORG, conv: CONV, kind: "completion" });
  assert.deepEqual(C.matchCompletion(`${BASE}/retry_completion?x=1`, "post"), { org: ORG, conv: CONV, kind: "retry_completion" });
  assert.equal(C.matchCompletion(`${BASE}/completion`, "GET"), null);
  assert.equal(C.matchCompletion(`${BASE}/completion_status`, "POST"), null);
  assert.equal(C.matchCompletion(`/api/organizations/${ORG}/chat_conversations/count_all/completion`, "POST"), null);
  assert.deepEqual(C.matchConversation(`${BASE}?tree=True&rendering_mode=messages`, "GET"), { org: ORG, conv: CONV });
  assert.deepEqual(C.matchConversation(`/api/organizations/${ORG}/chat_conversations/${CONV}`), { org: ORG, conv: CONV });
  assert.equal(C.matchConversation(`${BASE}/title`, "GET"), null);
  assert.equal(C.matchConversation(BASE, "PUT"), null);
  assert.equal(C.matchOrg(`/api/organizations/${ORG}/usage`), ORG);
  assert.equal(C.matchOrg("https://claude.ai/api/bootstrap"), null);
  assert.equal(C.matchOrg("not a url at all ::"), null);
});

test("SSE: Messages-API style stream, any chunk split", () => {
  const text = readFileSync(here("fixtures/api-style.sse"), "utf8");
  for (const split of [undefined, 1, 2, 3, 7, 64]) {
    const r = runSse(text, split);
    assert.equal(r.model, "claude-sonnet-5-5", `split ${split}`);
    assert.equal(r.outputChars, "Let me think.".length + "Hello there! ".length + "How can I help?".length);
    assert.equal(r.messageUuid, "7d3c0e8a-5b1f-4c11-9a52-0f6e2b9b1c01");
    assert.equal(r.limits.length, 1);
    assert.equal(r.usage, null);
  }
});

test("SSE: unknown events, CRLF, comments, multi-line data, [DONE], usage", () => {
  const text = readFileSync(here("fixtures/unknown-events.sse"), "utf8");
  for (const split of [undefined, 1, 5]) {
    const r = runSse(text, split);
    assert.equal(r.outputChars, "multi-line data".length + '{"q":1}'.length + "legacy".length, `split ${split}`);
    assert.equal(r.model, "claude-opus-5-5");
    assert.equal(r.messageUuid, "m_2");
    assert.equal(r.usage.input_tokens, 1200);
    assert.equal(r.usage.output_tokens, 42);
    assert.equal(r.usage.has_input, true);
  }
});

test("SSE: a \\r at a chunk boundary is not a blank line", () => {
  // Correct reading: one event whose data is two lines. Treating the split \r\n as two
  // line breaks would end the event early and yield two.
  const seen = [];
  const p = C.createSseParser((e) => seen.push(e.data));
  p.push('data: {"a":1}\r');
  p.push('\ndata: {"b":2}\r\n\r\n');
  p.end();
  assert.deepEqual(seen, ['{"a":1}\n{"b":2}']);
});

test("conversation size counts only the active branch, content once", () => {
  const json = JSON.parse(readFileSync(here("fixtures/conversation.json"), "utf8"));
  // a3: {"q":"x"} (9) + "Done." (5); h2: 6; a1: 3 + 5; h1: "Plan a trip" (11) + attachment (10)
  assert.equal(C.countConversationChars(json), 14 + 6 + 8 + 21);
  delete json.current_leaf_message_uuid; // no tree info → everything counts
  assert.equal(C.countConversationChars(json), 14 + 6 + 8 + 21 + "OTHER BRANCH SHOULD NOT COUNT".length);
  assert.equal(C.countConversationChars(null), 0);
});

test("prompt size from request body", () => {
  assert.equal(C.promptCharsFromBody({ prompt: "hello", attachments: [{ extracted_content: "abc" }, {}] }), 8);
  assert.equal(C.promptCharsFromBody("nope"), 0);
});

test("estimateEvent: estimate from sizes, or exact usage when the stream had it", () => {
  const at = Date.UTC(2026, 9, 14, 12);
  const e = C.estimateEvent({ conv: CONV, messageUuid: "u1", at, model: "claude-opus-5-5", promptChars: 401, outputChars: 800, contextChars: 4000 });
  assert.deepEqual(e, {
    key: `web:${CONV}:u1`,
    model: "claude-opus-5-5",
    input: 101,
    output: 200,
    cache_read: 1000 + C.SYSTEM_TOKENS,
    cache_write: 0,
    cache_write_1h: 0,
    at: new Date(at).toISOString(),
    estimated: true,
  });
  const noUuid = C.estimateEvent({ conv: CONV, at, promptChars: 0, outputChars: 0 });
  assert.equal(noUuid.key, `web:${CONV}:${at}`);
  assert.equal(noUuid.model, "unknown");
  const exact = C.estimateEvent({
    conv: CONV,
    messageUuid: "u2",
    at,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 5, has_input: true, has_output: true },
  });
  assert.equal(exact.estimated, false);
  assert.equal(exact.cache_read, 30);
  assert.equal(exact.cache_write, 5);
});

test("sanitizeEvent + queueAdd", () => {
  assert.equal(C.sanitizeEvent({ key: "" }), null);
  assert.equal(C.sanitizeEvent(null), null);
  const s = C.sanitizeEvent({ key: "k", input: -5, output: "12", cache_read: Infinity, at: "garbage", model: 7 });
  assert.equal(s.input, 0);
  assert.equal(s.output, 12);
  assert.equal(s.cache_read, 0);
  assert.equal(s.model, "unknown");
  assert.ok(Date.parse(s.at));
  const q = C.queueAdd([{ key: "a", output: 1 }, { key: "b" }], [{ key: "a", output: 2 }, { key: "c" }], 2);
  assert.deepEqual(q.map((e) => e.key), ["b", "c"]);
  assert.equal(C.queueAdd([{ key: "a", output: 1 }], [{ key: "a", output: 2 }])[0].output, 2);
});

test("parseMeter: usage endpoint shape, message_limit shape, junk → canonical readings", () => {
  const usage = {
    five_hour: { utilization: 22.0, resets_at: "2026-10-14T18:00:00.000Z" },
    seven_day: { utilization: 41.5, resets_at: "2026-10-19T16:00:00+00:00" },
    seven_day_opus: null,
  };
  assert.deepEqual(C.parseMeter(usage), {
    seven_day: { pct: 41.5, resets_at: "2026-10-19T16:00:00.000Z" },
    five_hour: { pct: 22, resets_at: "2026-10-14T18:00:00.000Z" },
  });
  const sse = readFileSync(here("fixtures/api-style.sse"), "utf8");
  const limit = runSse(sse).limits[0];
  assert.deepEqual(C.parseMeter(limit), {
    seven_day: { pct: 34, resets_at: new Date(1792500000 * 1000).toISOString() },
    five_hour: { pct: 12.5, resets_at: new Date(1792000000 * 1000).toISOString() },
  });
  assert.deepEqual(C.parseMeter({ data: { weekly: { utilization: "7", resets_at: 1792500000000 } } }), {
    seven_day: { pct: 7, resets_at: new Date(1792500000000).toISOString() },
  });
  assert.deepEqual(C.parseMeter({ seven_day: { utilization: 7, resets_at: 1792500000 }, five_hour: { utilization: 3 } }), {
    seven_day: { pct: 7, resets_at: new Date(1792500000 * 1000).toISOString() },
  }, "a 5-hour window without a reset time is left out");
  assert.equal(C.parseMeter({ seven_day: { utilization: 5 } }), null, "no reset time");
  assert.equal(C.parseMeter({ five_hour: { utilization: 5, resets_at: "2026-10-14T18:00:00Z" } }), null, "weekly required");
  assert.equal(C.parseMeter({ seven_day: { utilization: -1, resets_at: "2026-10-14T18:00:00Z" } }), null);
  assert.equal(C.parseMeter("nope"), null);
  assert.equal(C.parseMeter(null), null);
});

test("cleanReading: what crosses from a content script is made safe for POST /meter", () => {
  const now = Date.UTC(2026, 9, 15, 10);
  const resets = "2026-10-19T16:00:00.000Z";
  assert.deepEqual(C.cleanReading({ at: "2026-10-15T09:59:00Z", seven_day: { pct: 41.2, resets_at: resets }, org: "x" }, now), {
    at: "2026-10-15T09:59:00.000Z",
    seven_day: { pct: 41.2, resets_at: resets },
  });
  const future = C.cleanReading({ at: "2030-01-01T00:00:00Z", seven_day: { pct: 1, resets_at: resets }, five_hour: { pct: 2, resets_at: resets } }, now);
  assert.equal(future.at, new Date(now).toISOString(), "a clock from the future is replaced by now");
  assert.deepEqual(future.five_hour, { pct: 2, resets_at: resets });
  assert.equal(C.cleanReading({ at: "garbage", seven_day: { pct: 1, resets_at: resets } }, now).at, new Date(now).toISOString());
  assert.equal(C.cleanReading({ seven_day: { pct: "lots", resets_at: resets } }, now), null);
  assert.equal(C.cleanReading({ seven_day: { pct: 3 } }, now), null);
  assert.equal(C.cleanReading(null, now), null);
});

test("isBlocking: the cached-policy rule", () => {
  const now = Date.UTC(2026, 9, 14, 12);
  const later = new Date(now + 3 * 86400e3).toISOString();
  const earlier = new Date(now - 1000).toISOString();
  assert.equal(C.isBlocking({ state: "blocked", resets_at: later }, now - 1000, now), true);
  assert.equal(C.isBlocking({ state: "blocked", resets_at: earlier }, now - 1000, now), false, "week already reset");
  assert.equal(C.isBlocking({ state: "blocked", resets_at: later }, now - 2 * 86400e3, now), false, "stale → never block offline");
  assert.equal(C.isBlocking({ state: "blocked", resets_at: later }, now - 86400e3, now), false, "exactly a day old is too old");
  assert.equal(C.isBlocking({ state: "blocked", resets_at: later }, 0, now), false, "unknown age → don't block");
  assert.equal(C.isBlocking({ state: "blocked" }, now, now), false, "no reset time → don't block");
  assert.equal(C.isBlocking({ state: "over", resets_at: later }, now, now), false, "monitor only never blocks");
  assert.equal(C.isBlocking({ state: "warn", resets_at: later }, now, now), false);
  assert.equal(C.isBlocking({ state: "paused", resets_at: later }, now, now), false, "no such state any more");
  assert.equal(C.isBlocking(null, now, now), false);
});

test("reset times read like a person wrote them", () => {
  const now = Date.UTC(2026, 9, 14, 12); // Wed 14 Oct 2026, 12:00 UTC
  const o = { now, locale: "en-US", timeZone: "UTC" };
  assert.equal(C.formatReset(new Date(Date.UTC(2026, 9, 14, 21, 30)).toISOString(), o), "today at 9:30 PM");
  assert.equal(C.formatReset(new Date(Date.UTC(2026, 9, 15, 9, 0)).toISOString(), o), "tomorrow at 9:00 AM");
  assert.equal(C.formatReset(new Date(Date.UTC(2026, 9, 19, 21, 30)).toISOString(), o), "Monday at 9:30 PM");
  assert.equal(C.formatReset(new Date(Date.UTC(2026, 9, 19, 21, 30)).toISOString(), { ...o, short: true }), "Monday 9:30 PM");
  assert.equal(C.formatReset("garbage", o), "");
  // Same instant, different clock
  assert.equal(C.formatReset(new Date(Date.UTC(2026, 9, 14, 21, 30)).toISOString(), { ...o, timeZone: "Asia/Kolkata" }), "tomorrow at 3:00 AM");
});

test("status copy: plain words for every state and scope", () => {
  const now = Date.UTC(2026, 9, 14, 12);
  const o = { now, locale: "en-US", timeZone: "UTC" };
  const resets = new Date(Date.UTC(2026, 9, 19, 21, 30)).toISOString();
  const acct = (state, extra) => ({ state, scope: "account", basis: "meter", resets_at: resets, pct: 85, ...extra });
  assert.equal(C.headline(acct("ok"), o), "Within budget");
  assert.equal(C.headline(acct("warn"), o), "Getting close");
  assert.equal(C.headline(acct("over"), o), "Over budget");
  assert.equal(C.headline(acct("blocked"), o), "Budget used up");
  assert.equal(C.headline(acct("blocked", { scope: "device" }), o), "Cap used up");
  assert.equal(C.shortLine(acct("blocked"), o), "Budget used up · resets Monday 9:30 PM");
  assert.equal(C.shortLine(acct("warn"), o), "Getting close");
  assert.equal(C.headline(null), "Checking…");
  assert.equal(C.detailLine(acct("ok"), o), "It resets Monday at 9:30 PM.");
  assert.equal(C.detailLine(acct("over"), o), "Monitor only, so nothing is blocked. It resets Monday at 9:30 PM.");
  assert.equal(C.detailLine(acct("blocked"), o), "It resets Monday at 9:30 PM. You can change the budget in the clare dashboard.");
  assert.equal(
    C.detailLine(acct("blocked", { scope: "device" }), o),
    "This browser has used its weekly cap. It resets Monday at 9:30 PM. You can change the cap in the clare dashboard."
  );
  assert.equal(C.detailLine(acct("blocked", { resets_at: null }), o), "You can change the budget in the clare dashboard.");
  assert.equal(C.ringCaption(acct("ok")), "of weekly budget used");
  assert.equal(C.ringCaption(acct("ok", { scope: "device" })), "of this browser's weekly cap");
  assert.equal(C.basisLine(acct("ok")), "From Claude's official usage meter.");
  assert.match(C.basisLine(acct("ok", { basis: "estimate" })), /^Estimated/);
  assert.equal(C.bannerText({ state: "blocked", message: "From the server." }), "From the server.");
  assert.equal(
    C.bannerText(acct("blocked"), o),
    "You've used all of this week's Claude budget. It resets Monday at 9:30 PM. You can change the budget in the clare dashboard."
  );
  assert.equal(C.bannerText(acct("warn"), o), "Heads up: you've used 85% of this week's Claude budget. It resets Monday at 9:30 PM.");
  assert.equal(C.bannerText(acct("ok"), o), "");
  for (const state of ["ok", "warn", "over", "blocked"]) {
    for (const scope of ["account", "device"]) {
      const st = acct(state, { scope });
      const words = [C.headline(st, o), C.shortLine(st, o), C.detailLine(st, o), C.bannerText(st, o), C.ringCaption(st)].join(" ");
      assert.doesNotMatch(words, /token|credit|\$|quota|API|share|member|invite|manager|paused/i, `${state}/${scope}`);
    }
  }
  assert.equal(C.pctLabel(0.4), "<1%");
  assert.equal(C.pctLabel(84.6), "85%");
  assert.equal(C.pctLabel(0), "0%");
});

test("statusNotice: one notification per state per week", () => {
  const resets = "2026-10-19T16:00:00.000Z";
  assert.equal(C.statusNotice({ state: "ok", resets_at: resets }), null);
  assert.equal(C.statusNotice({ state: "warn", resets_at: resets }), "warn|" + resets);
  assert.equal(C.statusNotice({ state: "blocked", resets_at: resets }), "blocked|" + resets);
  assert.equal(C.statusNotice({ state: "over", resets_at: resets }), "over|" + resets);
  assert.notEqual(C.statusNotice({ state: "warn", resets_at: resets }), C.statusNotice({ state: "warn", resets_at: "2026-10-26T16:00:00.000Z" }));
  assert.equal(C.statusNotice({ state: "warn" }), null);
  assert.equal(C.statusNotice(null), null);
});

test("enroll links and codes", () => {
  assert.equal(C.parseEnrollCode("https://you.github.io/clare/enroll.html#k3f9x2ab"), "k3f9x2ab");
  assert.equal(C.parseEnrollCode("  https://x.io/enroll.html#code=k3F9x2Ab&utm=1 "), "k3F9x2Ab");
  assert.equal(C.parseEnrollCode("https://x.io/enroll.html?code=k3F9x2Ab"), "k3F9x2Ab");
  assert.equal(C.parseEnrollCode("k3F9x2Ab"), "k3F9x2Ab");
  assert.equal(C.parseEnrollCode("https://x.io/enroll.html"), null);
  assert.equal(C.parseEnrollCode("hello world"), null);
  assert.equal(C.parseEnrollCode(""), null);
});

test("browser labels", () => {
  assert.equal(C.browserLabel({ brands: [{ brand: "Google Chrome" }], platform: "macOS" }, "").label, "Chrome on Mac");
  assert.equal(C.browserLabel({ brands: [{ brand: "Microsoft Edge" }], platform: "Windows" }, "").label, "Edge on Windows");
  assert.equal(C.browserLabel(null, "Mozilla/5.0 (X11; Linux x86_64) Chrome/140").label, "Chrome on Linux");
  assert.equal(C.browserLabel(null, "").label, "Chrome");
});
