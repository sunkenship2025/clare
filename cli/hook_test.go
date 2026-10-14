package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func decode(t *testing.T, s string) map[string]any {
	t.Helper()
	if strings.TrimSpace(s) == "" {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatalf("hook printed invalid JSON %q: %v", s, err)
	}
	return m
}

func session(t *testing.T, ta *testApp) map[string]any {
	dir := t.TempDir()
	path := filepath.Join(dir, "sess.jsonl")
	writeFile(t, path, assistantLine("m1", "claude-opus-5-5", 2, 50, 100, 10, 10, ta.clock))
	return map[string]any{"session_id": "sess", "transcript_path": path}
}

func systemMessage(t *testing.T, out string) string {
	t.Helper()
	m := decode(t, out)
	if _, blocked := m["decision"]; blocked {
		t.Fatalf("expected a message, not a block: %v", m)
	}
	msg, _ := m["systemMessage"].(string)
	return msg
}

func TestPromptAllowedReportsUsage(t *testing.T) {
	api := newFakeAPI(t)
	ta := newTestApp(t)
	ta.install(t, api.srv.URL)
	in := session(t, ta)

	if out := ta.hook(t, "UserPromptSubmit", in); out != "" {
		t.Fatalf("ok status should print nothing, got %s", out)
	}
	if len(api.events) != 1 || api.events[0].Key != "cc:m1" || api.events[0].Output != 50 {
		t.Fatalf("usage not reported: %+v", api.events)
	}
	if api.lastTZ == "" {
		t.Fatal("X-Clare-TZ header missing")
	}
	// Same transcript again: nothing new to report, falls back to /check.
	ta.hook(t, "UserPromptSubmit", in)
	if len(api.events) != 1 || api.hitCount("/check") != 1 {
		t.Fatalf("expected no re-report and one /check; events=%d check=%d", len(api.events), api.hitCount("/check"))
	}
}

func TestPromptBlocked(t *testing.T) {
	api := newFakeAPI(t)
	api.setStatus(blockedStatus())
	ta := newTestApp(t)
	ta.install(t, api.srv.URL)

	out := decode(t, ta.hook(t, "UserPromptSubmit", session(t, ta)))
	if out["decision"] != "block" || !strings.Contains(out["reason"].(string), "all of this week's Claude budget") {
		t.Fatalf("want block, got %v", out)
	}
}

func TestSessionStartTellsButCannotBlock(t *testing.T) {
	api := newFakeAPI(t)
	api.setStatus(blockedStatus())
	ta := newTestApp(t)
	ta.install(t, api.srv.URL)

	if msg := systemMessage(t, ta.hook(t, "SessionStart", session(t, ta))); !strings.Contains(msg, "all of this week's Claude budget") {
		t.Fatalf("SessionStart should explain the block, got %q", msg)
	}
}

func TestPromptWarnOncePerSession(t *testing.T) {
	api := newFakeAPI(t)
	api.setStatus(warnStatus())
	ta := newTestApp(t)
	ta.install(t, api.srv.URL)
	in := session(t, ta)

	if msg := systemMessage(t, ta.hook(t, "UserPromptSubmit", in)); !strings.Contains(msg, "85%") {
		t.Fatalf("want warning, got %q", msg)
	}
	if out := ta.hook(t, "UserPromptSubmit", in); out != "" {
		t.Fatalf("warning must show once per session, got %s", out)
	}
	in["session_id"] = "other"
	if out := ta.hook(t, "UserPromptSubmit", in); out == "" {
		t.Fatal("a new session should warn again")
	}
}

func TestOverBudgetWarnsButNeverBlocks(t *testing.T) {
	api := newFakeAPI(t)
	api.setStatus(overStatus())
	ta := newTestApp(t)
	ta.install(t, api.srv.URL)
	in := session(t, ta)

	if msg := systemMessage(t, ta.hook(t, "UserPromptSubmit", in)); !strings.Contains(msg, "monitor only") {
		t.Fatalf("over budget should say so, got %q", msg)
	}
	if out := ta.hook(t, "UserPromptSubmit", in); out != "" {
		t.Fatalf("over-budget note once per session, got %s", out)
	}
	ta.clock = ta.clock.Add(time.Minute)
	if out := ta.hook(t, "PreToolUse", in); out != "" {
		t.Fatalf("monitor-only must never deny tools, got %s", out)
	}
}

func TestOfflineCachedPolicy(t *testing.T) {
	api := newFakeAPI(t)
	api.setStatus(blockedStatus()) // resets in 72h
	ta := newTestApp(t)
	ta.install(t, api.srv.URL)
	in := session(t, ta)
	ta.hook(t, "UserPromptSubmit", in) // caches "blocked"

	api.srv.Close() // server goes away

	ta.clock = ta.clock.Add(23 * time.Hour)
	if out := decode(t, ta.hook(t, "UserPromptSubmit", in)); out["decision"] != "block" {
		t.Fatalf("offline with a recent cached block should block, got %v", out)
	}

	// Cache older than 24 h no longer blocks, even though the week hasn't reset.
	ta.clock = ta.clock.Add(2 * time.Hour)
	if out := ta.hook(t, "UserPromptSubmit", in); out != "" {
		t.Fatalf("a stale cached block must allow, got %s", out)
	}
}

func TestOfflineCachedBlockEndsAtReset(t *testing.T) {
	api := newFakeAPI(t)
	st := blockedStatus()
	st.ResetsAt = time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)
	api.setStatus(st)
	ta := newTestApp(t)
	ta.install(t, api.srv.URL)
	in := session(t, ta)
	ta.hook(t, "UserPromptSubmit", in)
	api.srv.Close()

	ta.clock = ta.clock.Add(3 * time.Hour)
	if out := ta.hook(t, "UserPromptSubmit", in); out != "" {
		t.Fatalf("a cached block for a week that has reset must allow, got %s", out)
	}
}

func TestOfflineWithoutCacheAllowsAndQueues(t *testing.T) {
	api := newFakeAPI(t)
	ta := newTestApp(t)
	ta.install(t, api.srv.URL)
	api.srv.Close()
	in := session(t, ta)

	if out := ta.hook(t, "UserPromptSubmit", in); out != "" {
		t.Fatalf("a network problem must never block, got %s", out)
	}
	if q := ta.loadMeter().Queue; len(q) != 1 {
		t.Fatalf("usage should stay queued while offline: %+v", q)
	}
}

func TestPreToolUseThrottleAndMidTurnStop(t *testing.T) {
	api := newFakeAPI(t)
	ta := newTestApp(t)
	ta.install(t, api.srv.URL)
	in := session(t, ta)

	ta.hook(t, "PreToolUse", in) // first call syncs
	syncs := api.hitCount("/report") + api.hitCount("/check")
	if syncs != 1 {
		t.Fatalf("first PreToolUse should sync once, got %d", syncs)
	}

	api.setStatus(blockedStatus())
	ta.clock = ta.clock.Add(5 * time.Second)
	if out := ta.hook(t, "PreToolUse", in); out != "" {
		t.Fatalf("within 30s: no network, cached ok status → allow; got %s", out)
	}
	if n := api.hitCount("/report") + api.hitCount("/check"); n != syncs {
		t.Fatalf("throttle broken: %d calls", n)
	}

	ta.clock = ta.clock.Add(31 * time.Second)
	out := decode(t, ta.hook(t, "PreToolUse", in))
	hso, _ := out["hookSpecificOutput"].(map[string]any)
	if out["continue"] != false || hso["permissionDecision"] != "deny" {
		t.Fatalf("over the budget mid-turn should stop Claude, got %v", out)
	}
}

func TestBrokenConfigWarnsOnceWithoutBlocking(t *testing.T) {
	ta := newTestApp(t)
	ta.install(t, "http://127.0.0.1:1")
	os.Remove(ta.configPath())
	in := map[string]any{"session_id": "s1"}

	if msg := systemMessage(t, ta.hook(t, "UserPromptSubmit", in)); !strings.Contains(msg, "sudo clare doctor") {
		t.Fatalf("want a doctor hint, got %q", msg)
	}
	if out := ta.hook(t, "UserPromptSubmit", in); out != "" {
		t.Fatalf("the hint shows once per session, got %s", out)
	}
	if out := ta.hook(t, "PreToolUse", in); out != "" {
		t.Fatalf("missing config must never deny tools, got %s", out)
	}
	// Not installed at all (no drop-in): stay out of the way.
	os.Remove(ta.dropInPath())
	if out := ta.hook(t, "UserPromptSubmit", map[string]any{"session_id": "s2"}); out != "" {
		t.Fatalf("not installed should be silent, got %s", out)
	}
}

func TestRevokedStopsEnforcingAndWatchdogUninstalls(t *testing.T) {
	api := newFakeAPI(t)
	api.setStatus(blockedStatus())
	ta := newTestApp(t)
	ta.install(t, api.srv.URL)
	in := session(t, ta)
	ta.hook(t, "UserPromptSubmit", in) // cached "blocked"

	api.set(func(f *fakeAPI) { f.revoked = true })
	ta.clock = ta.clock.Add(time.Minute)
	if msg := systemMessage(t, ta.hook(t, "UserPromptSubmit", in)); !strings.Contains(msg, "removed from clare") {
		t.Fatalf("revoked device should say so once, got %q", msg)
	}
	if out := ta.hook(t, "UserPromptSubmit", in); out != "" {
		t.Fatalf("revoked notice once per session, no block; got %s", out)
	}
	// Even offline afterwards, the old cached block must not come back.
	api.srv.Close()
	ta.clock = ta.clock.Add(time.Minute)
	if out := ta.hook(t, "PreToolUse", in); out != "" {
		t.Fatalf("revoked device must not enforce from cache, got %s", out)
	}

	api2 := newFakeAPI(t)
	api2.revoked = true
	ta2 := newTestApp(t)
	ta2.install(t, api2.srv.URL)
	if code := ta2.run([]string{"watchdog"}); code != 0 {
		t.Fatalf("watchdog exit %d", code)
	}
	if fileExists(ta2.dropInPath()) || fileExists(ta2.clareDir()) {
		t.Fatal("watchdog should self-uninstall on 410 revoked")
	}
}

func TestUnauthorizedNeverBlocks(t *testing.T) {
	api := newFakeAPI(t)
	api.setStatus(blockedStatus())
	ta := newTestApp(t)
	ta.install(t, api.srv.URL)
	in := session(t, ta)
	ta.hook(t, "UserPromptSubmit", in) // cached "blocked"

	api.set(func(f *fakeAPI) { f.unauthorized = true })
	ta.clock = ta.clock.Add(time.Minute)
	if msg := systemMessage(t, ta.hook(t, "UserPromptSubmit", in)); !strings.Contains(msg, "sudo clare doctor") {
		t.Fatalf("a rejected token is a health problem to mention, got %q", msg)
	}
	ta.clock = ta.clock.Add(time.Minute)
	if out := ta.hook(t, "PreToolUse", in); out != "" {
		t.Fatalf("401 must never block, got %s", out)
	}
}

func TestReportCarriesNewMeterReadingOnce(t *testing.T) {
	api := newFakeAPI(t)
	ta := newTestApp(t)
	ta.install(t, api.srv.URL)
	in := map[string]any{"session_id": "s"}
	resets := ta.clock.Add(48 * time.Hour).UTC().Format(time.RFC3339)
	save := func(pct float64, at time.Time) {
		t.Helper()
		r := Reading{At: at.UTC().Format(time.RFC3339), SevenDay: &MeterWindow{Pct: pct, ResetsAt: resets}}
		if err := writeJSONAtomic(ta.statePath("reading.json"), r, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	save(41, ta.clock)
	ta.hook(t, "UserPromptSubmit", in)
	if len(api.meters) != 1 || api.meters[0].SevenDay.Pct != 41 || api.meters[0].SevenDay.ResetsAt != resets {
		t.Fatalf("reading not sent with /report: %+v", api.meters)
	}

	ta.clock = ta.clock.Add(time.Minute)
	save(41, ta.clock) // same numbers, newer reading
	ta.hook(t, "UserPromptSubmit", in)
	if len(api.meters) != 1 || api.hitCount("/check") != 1 {
		t.Fatalf("an unchanged reading shouldn't be resent right away: meters=%d check=%d", len(api.meters), api.hitCount("/check"))
	}

	ta.clock = ta.clock.Add(11 * time.Minute)
	save(41, ta.clock)
	ta.hook(t, "UserPromptSubmit", in)
	if len(api.meters) != 2 {
		t.Fatalf("an unchanged reading is refreshed after 10 min: %d", len(api.meters))
	}

	ta.clock = ta.clock.Add(time.Minute)
	save(42, ta.clock)
	ta.hook(t, "UserPromptSubmit", in)
	if len(api.meters) != 3 || api.meters[2].SevenDay.Pct != 42 {
		t.Fatalf("a changed reading goes out on the next hook: %+v", api.meters)
	}

	// A reading for a week that already reset is never sent.
	ta.clock = ta.clock.Add(72 * time.Hour)
	save(99, ta.clock.Add(-time.Minute))
	ta.hook(t, "UserPromptSubmit", in)
	if len(api.meters) != 3 {
		t.Fatalf("stale reading sent: %+v", api.meters[len(api.meters)-1])
	}
}

func TestWatchdogHeartbeatAppliesStrictSetting(t *testing.T) {
	api := newFakeAPI(t) // heartbeat answers strict_hooks=false
	ta := newTestApp(t)
	ta.install(t, api.srv.URL)
	if err := ta.writeBackup(); err != nil {
		t.Fatal(err)
	}

	ta.run([]string{"watchdog"})
	if api.hitCount("/heartbeat") != 1 {
		t.Fatal("no heartbeat")
	}
	cfg, _ := ta.loadConfig()
	if cfg.StrictHooks || !ta.dropInHealthy(false) {
		t.Fatal("strict_hooks=false from the server was not applied")
	}
	if !fileExists(ta.systemStatusPath()) {
		t.Fatal("watchdog should cache status for hooks")
	}
}

func TestEnrollInstallsFiles(t *testing.T) {
	api := newFakeAPI(t)
	ta := newTestApp(t)

	code := ta.run([]string{"enroll", "https://me.github.io/clare/enroll.html#k3F9", "--api", api.srv.URL, "--web", "https://me.github.io/clare", "--label", "Work Mac", "--no-browser"})
	if code != 0 {
		t.Fatalf("enroll failed: %s", ta.out.String())
	}
	b := api.enrollBody
	if b.Code != "k3F9" || b.Kind != "cli" || b.Label != "Work Mac" || b.Info["machine_id"] == "" {
		t.Fatalf("bad enroll request: %+v", b)
	}
	cfg, err := ta.loadConfig()
	if err != nil || cfg.Token != "clr_test" || cfg.DeviceID != "dev1" || cfg.Web != "https://me.github.io/clare" || cfg.EnrolledAt == "" {
		t.Fatalf("config: %+v %v", cfg, err)
	}
	if cfg.Label != "Test Mac" {
		t.Fatalf("the server's label for this device should win: %q", cfg.Label)
	}
	for _, p := range []string{ta.binPath(), ta.dropInPath(), filepath.Join(ta.backupDir(), "checksums.json"), ta.systemStatusPath()} {
		if !fileExists(p) {
			t.Fatalf("missing %s", p)
		}
	}
	var dropIn map[string]any
	_ = readJSONFile(ta.dropInPath(), &dropIn)
	if sl, _ := dropIn["statusLine"].(map[string]any); !strings.Contains(sl["command"].(string), "statusline") {
		t.Fatalf("drop-in has no status line: %v", dropIn)
	}
	out := ta.out.String()
	for _, want := range []string{"enrolled as", "weekly budget", "clare status"} {
		if !strings.Contains(out, want) {
			t.Fatalf("enroll output missing %q:\n%s", want, out)
		}
	}
	for _, banned := range []string{"share", "invite", "Mom"} {
		if strings.Contains(out, banned) {
			t.Fatalf("enroll output mentions %q:\n%s", banned, out)
		}
	}

	// Re-enrolling the same computer on the same server keeps the original enrollment time.
	first := cfg.EnrolledAt
	ta.clock = ta.clock.Add(time.Hour)
	ta.out.Reset()
	if ta.run([]string{"enroll", "k3F9", "--no-browser"}) != 0 {
		t.Fatalf("re-enroll failed: %s", ta.out.String())
	}
	if cfg, _ := ta.loadConfig(); cfg.EnrolledAt != first || cfg.API != api.srv.URL {
		t.Fatalf("re-enroll should reuse the saved server and enrollment time: %+v", cfg)
	}

	// Bad codes explain themselves in plain words.
	ta2 := newTestApp(t)
	if ta2.run([]string{"enroll", "expired", "--api", api.srv.URL}) == 0 || !strings.Contains(ta2.out.String(), "expired") {
		t.Fatalf("expired enroll: %s", ta2.out.String())
	}
	ta3 := newTestApp(t)
	if ta3.run([]string{"enroll", "nope", "--api", api.srv.URL}) == 0 || !strings.Contains(ta3.out.String(), "isn't valid") {
		t.Fatalf("invalid enroll: %s", ta3.out.String())
	}
	ta4 := newTestApp(t)
	if ta4.run([]string{"enroll"}) == 0 || !strings.Contains(ta4.out.String(), "Add a device") {
		t.Fatalf("missing code: %s", ta4.out.String())
	}
}

func TestStatusCommand(t *testing.T) {
	api := newFakeAPI(t)
	st := warnStatus()
	capPts, capPct := 30.0, 50.0
	st.Device = &DeviceUse{ID: "dev1", Label: "Test Mac", Used: 15, Budget: &capPts, Pct: &capPct}
	api.setStatus(st)
	ta := newTestApp(t)
	ta.install(t, api.srv.URL)

	ta.run([]string{"status"})
	out := ta.out.String()
	for _, want := range []string{"Test Mac", "85% of your budget", "budget 90%", "This device", "cap 30%", "Resets", "official usage meter", "enforced", "Connected", "Heads up"} {
		if !strings.Contains(out, want) {
			t.Fatalf("status output missing %q:\n%s", want, out)
		}
	}

	st = okStatus(20)
	st.Basis = "estimate"
	st.Enforce = false
	api.setStatus(st)
	ta.out.Reset()
	ta.run([]string{"status"})
	out = ta.out.String()
	for _, want := range []string{"about 20%", "estimate", "monitor only"} {
		if !strings.Contains(out, want) {
			t.Fatalf("estimate status missing %q:\n%s", want, out)
		}
	}

	api.set(func(f *fakeAPI) { f.revoked = true })
	ta.out.Reset()
	if ta.run([]string{"status"}) == 0 || !strings.Contains(ta.out.String(), "removed from clare") {
		t.Fatalf("revoked status: %s", ta.out.String())
	}
}

var sharingWords = regexp.MustCompile(`(?i)\b(share[sd]?|sharing|members?|invite[sd]?|invitation|managers?|mom|joy|family)\b`)

func TestCLIHasNoSharingWords(t *testing.T) {
	files, _ := filepath.Glob("*.go")
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		data, _ := os.ReadFile(f)
		text := strings.ReplaceAll(string(data), "/usr/share/zoneinfo", "")
		if w := sharingWords.FindString(text); w != "" {
			t.Errorf("%s still mentions %q", f, w)
		}
	}
}
