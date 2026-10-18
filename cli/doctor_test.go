package main

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestDoctorSaysWhetherTheMeterIsRead(t *testing.T) {
	api := newFakeAPI(t)
	ta := newTestApp(t)
	cfg := ta.install(t, api.srv.URL)
	doctor := func() string {
		ta.out.Reset()
		ta.run([]string{"doctor"})
		return ta.out.String()
	}
	at := func(d time.Duration) *string {
		s := ta.clock.Add(-d).UTC().Format(time.RFC3339)
		return &s
	}
	has := func(out string, want ...string) {
		t.Helper()
		for _, w := range want {
			if !strings.Contains(out, w) {
				t.Fatalf("doctor output missing %q:\n%s", w, out)
			}
		}
	}

	// Nothing here has read it and nothing else has for a day and a half: say what to do.
	st := okStatus(10)
	st.MeterAt = at(37 * time.Hour)
	api.setStatus(st)
	out := doctor()
	has(out, "Claude's usage meter was last read 37 hours ago, so usage on devices without clare isn't counted yet",
		"Claude Code on this computer hasn't read it yet", "Use Claude Code in a terminal now", "claude.ai in Chrome")

	// Profiles clare doesn't cover never read it for clare.
	cfg.Profiles = []string{"pranav"}
	if err := ta.saveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	has(doctor(), "Only these Claude Code profiles count: pranav.")

	// Another device read it just now: nothing to do here.
	st.MeterAt = at(4 * time.Minute)
	api.setStatus(st)
	out = doctor()
	has(out, "Claude's usage meter was read 4 minutes ago", "hasn't read it lately, but another device has")
	if strings.Contains(out, "terminal now") {
		t.Fatalf("no steps needed when another device reads it:\n%s", out)
	}

	// This computer's status line read it.
	if err := os.MkdirAll(ta.StateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	r := &Reading{At: *at(2 * time.Minute), SevenDay: &MeterWindow{Pct: 12, ResetsAt: ta.clock.Add(48 * time.Hour).UTC().Format(time.RFC3339)}}
	if err := writeJSONAtomic(ta.statePath("reading.json"), r, 0o600); err != nil {
		t.Fatal(err)
	}
	has(doctor(), "Claude Code on this computer read it 2 minutes ago")

	// Before any reading this week the server estimates.
	st = okStatus(10)
	st.Basis = "estimate"
	api.setStatus(st)
	has(doctor(), "hasn't been read yet this week, so clare is estimating")
}

func TestSessionToldOnceWhenTheMeterIsUnreadForADay(t *testing.T) {
	api := newFakeAPI(t)
	ta := newTestApp(t)
	ta.install(t, api.srv.URL)
	in := session(t, ta)

	st := okStatus(10)
	old := ta.clock.Add(-30 * time.Hour).UTC().Format(time.RFC3339)
	st.MeterAt = &old
	api.setStatus(st)
	msg := systemMessage(t, ta.hook(t, "SessionStart", in))
	if !strings.Contains(msg, "Claude's usage meter was last read 30 hours ago, so usage on devices without clare isn't counted yet.") {
		t.Fatalf("want a stale-meter note, got %q", msg)
	}
	if out := ta.hook(t, "UserPromptSubmit", in); strings.Contains(out, "usage meter") {
		t.Fatalf("told twice in one session: %s", out)
	}

	// Read a few hours ago: the status line says how old it is, no note.
	recent := ta.clock.Add(-5 * time.Hour).UTC().Format(time.RFC3339)
	st.MeterAt = &recent
	api.setStatus(st)
	in["session_id"] = "another"
	if out := ta.hook(t, "SessionStart", in); strings.Contains(out, "usage meter") {
		t.Fatalf("a few hours isn't worth a note: %s", out)
	}
}
