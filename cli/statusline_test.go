package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// statusLineRun pipes a status-line payload into `clare statusline` and returns stdout.
func (ta *testApp) statusLine(t *testing.T, payload map[string]any) string {
	t.Helper()
	data, _ := json.Marshal(payload)
	ta.In = bytes.NewReader(data)
	ta.out.Reset()
	if code := ta.run([]string{"statusline"}); code != 0 {
		t.Fatalf("statusline exited %d", code)
	}
	return ta.out.String()
}

func cacheStatus(t *testing.T, ta *testApp, st Status) {
	t.Helper()
	c := ta.loadStatusCache()
	c.Status, c.FetchedAt = &st, ta.clock
	ta.saveStatusCache(c)
}

func TestStatusLineSavesReadingAndRunsYourCommand(t *testing.T) {
	ta := newTestApp(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	writeFile(t, filepath.Join(home, ".claude", "settings.json"),
		`{"statusLine":{"type":"command","command":"cat > \"$HOME/seen.json\"; echo \"my line in $(basename \"$PWD\")\""}}`)
	cacheStatus(t, ta, okStatus(46.7))

	project := t.TempDir()
	resets := ta.clock.Add(50 * time.Hour).Truncate(time.Second)
	payload := map[string]any{
		"cwd":       project,
		"workspace": map[string]any{"current_dir": project, "project_dir": project},
		"rate_limits": map[string]any{
			"seven_day": map[string]any{"used_percentage": 41.5, "resets_at": resets.Unix()},
			"five_hour": map[string]any{"used_percentage": 12, "resets_at": resets.Add(-46 * time.Hour).Unix()},
		},
	}
	out := ta.statusLine(t, payload)
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 2 || lines[0] != "my line in "+filepath.Base(project) || lines[1] != "clare · 46% of weekly budget" {
		t.Fatalf("want your line then clare's, got %q", out)
	}

	seen, _ := os.ReadFile(filepath.Join(home, "seen.json"))
	if !strings.Contains(string(seen), "rate_limits") {
		t.Fatalf("your command should get the same stdin, got %q", seen)
	}

	r := ta.loadReading()
	if r == nil || r.SevenDay.Pct != 41.5 || r.SevenDay.ResetsAt != resets.UTC().Format(time.RFC3339) {
		t.Fatalf("reading not saved: %+v", r)
	}
	if r.FiveHour == nil || r.FiveHour.Pct != 12 || r.At == "" {
		t.Fatalf("five-hour window or time missing: %+v", r)
	}
}

func TestStatusLinePrefersProjectSettingsAndNeverRunsItself(t *testing.T) {
	ta := newTestApp(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	project := t.TempDir()
	writeFile(t, filepath.Join(home, ".claude", "settings.json"), `{"statusLine":{"type":"command","command":"echo user"}}`)
	writeFile(t, filepath.Join(project, ".claude", "settings.json"), `{"statusLine":{"type":"command","command":"echo project"}}`)
	writeFile(t, filepath.Join(project, ".claude", "settings.local.json"), `{"statusLine":{"type":"command","command":"echo local"}}`)

	in := map[string]any{"cwd": project, "workspace": map[string]any{"project_dir": project}}
	if out := ta.statusLine(t, in); out != "local\n" {
		t.Fatalf("settings.local.json wins, got %q", out)
	}

	// clare's own command (anywhere) is skipped, falling through to the next one.
	writeFile(t, filepath.Join(project, ".claude", "settings.local.json"), `{"statusLine":{"type":"command","command":"clare statusline"}}`)
	writeFile(t, filepath.Join(project, ".claude", "settings.json"), `{"statusLine":{"type":"command","command":"\"`+ta.binPath()+`\" statusline"}}`)
	if out := ta.statusLine(t, in); out != "user\n" {
		t.Fatalf("clare must never run itself, got %q", out)
	}
	writeFile(t, filepath.Join(home, ".claude", "settings.json"), `{"statusLine":{"type":"command","command":"/usr/local/bin/clare statusline --x"}}`)
	if out := ta.statusLine(t, in); out != "" {
		t.Fatalf("nothing of yours to run and no status cached, got %q", out)
	}
}

func TestStatusLineNeverFailsOrHangs(t *testing.T) {
	ta := newTestApp(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	writeFile(t, filepath.Join(home, ".claude", "settings.json"), `{"statusLine":{"type":"command","command":"echo partial; sleep 10"}}`)

	ta.In = strings.NewReader("not json at all")
	ta.out.Reset()
	started := time.Now()
	if code := ta.run([]string{"statusline"}); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if d := time.Since(started); d > 5*time.Second {
		t.Fatalf("a slow status line must be cut off, took %s", d)
	}
	if ta.loadReading() != nil {
		t.Fatal("no rate_limits, nothing to save")
	}
}

func TestStatusLineText(t *testing.T) {
	ta := newTestApp(t)
	if got := ta.statusLineText(); got != "" {
		t.Fatalf("no cache → no line, got %q", got)
	}
	st := okStatus(12.9)
	st.Basis = "estimate"
	cacheStatus(t, ta, st)
	if got := ta.statusLineText(); got != "clare · ~12% of weekly budget" {
		t.Fatalf("estimate: %q", got)
	}
	st = blockedStatus()
	st.Scope = "device"
	cacheStatus(t, ta, st)
	if got := ta.statusLineText(); got != "clare · this device's weekly budget used up" {
		t.Fatalf("blocked device: %q", got)
	}
	ta.clock = ta.clock.Add(80 * time.Hour)
	if got := ta.statusLineText(); got != "" {
		t.Fatalf("last week's numbers must not show, got %q", got)
	}
}

func TestParseRateLimitsIsLenient(t *testing.T) {
	now := time.Date(2026, 10, 15, 10, 0, 0, 0, time.UTC)
	resets := time.Date(2026, 10, 19, 16, 0, 0, 0, time.UTC)
	cases := []string{
		`{"seven_day":{"used_percentage":41,"resets_at":` + jsonNum(resets.Unix()) + `}}`,
		`{"seven_day":{"used_percentage":"41","resets_at":` + jsonNum(resets.UnixMilli()) + `}}`,
		`{"seven_day":{"utilization":41,"resets_at":"2026-10-19T16:00:00Z"}}`,
		`{"seven_day":{"pct":41,"resetsAt":"` + jsonNum(resets.Unix()) + `"}}`,
	}
	for _, c := range cases {
		var raw map[string]json.RawMessage
		if err := json.Unmarshal([]byte(c), &raw); err != nil {
			t.Fatal(err)
		}
		r := parseRateLimits(raw, now)
		if r == nil || r.SevenDay.Pct != 41 || r.SevenDay.ResetsAt != "2026-10-19T16:00:00Z" || r.At != "2026-10-15T10:00:00Z" || r.FiveHour != nil {
			t.Fatalf("%s → %+v", c, r)
		}
	}
	for _, bad := range []string{`{}`, `{"seven_day":null}`, `{"seven_day":{"used_percentage":41}}`, `{"seven_day":{"used_percentage":-1,"resets_at":1}}`, `{"five_hour":{"used_percentage":4,"resets_at":1792000000}}`} {
		var raw map[string]json.RawMessage
		_ = json.Unmarshal([]byte(bad), &raw)
		if r := parseRateLimits(raw, now); r != nil {
			t.Fatalf("%s should be rejected, got %+v", bad, r)
		}
	}
}

func jsonNum(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}
