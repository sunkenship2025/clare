package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProfileMatching(t *testing.T) {
	home, _ := os.UserHomeDir()
	pranav := filepath.Join(home, ".clauth", "profiles", "pranav", "runtime-38378-0")
	god := filepath.Join(home, ".clauth", "profiles", "god", "runtime-111-0")
	cases := []struct {
		entry, dir string
		want       bool
	}{
		{"pranav", pranav, true},
		{"pranav", god, false},
		{"god", god, true},
		{"pran", pranav, false},
		{"~/.clauth/profiles/pranav", pranav, true},
		{"~/.clauth/profiles/pranav", god, false},
		{filepath.Join(home, "work-claude"), filepath.Join(home, "work-claude"), true},
		{"work-claude", filepath.Join(home, "work-claude"), true},
		{"", pranav, false},
	}
	for _, c := range cases {
		if got := profileMatches(c.entry, c.dir); got != c.want {
			t.Errorf("profileMatches(%q, %q) = %v", c.entry, c.dir, got)
		}
	}
	if got := parseProfiles([]string{"pranav, work", "pranav", " "}); strings.Join(got, "|") != "pranav|work" {
		t.Fatal(got)
	}
}

func TestOtherProfilesAreLeftAlone(t *testing.T) {
	home, _ := os.UserHomeDir()
	api := newFakeAPI(t)
	api.setStatus(blockedStatus())
	ta := newTestApp(t)
	cfg := ta.install(t, api.srv.URL)
	cfg.Profiles = []string{"pranav"}
	_ = ta.saveConfig(cfg)
	prompt := map[string]any{"session_id": "s1", "hook_event_name": "UserPromptSubmit"}

	// god is a different Claude account: no report, no block.
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".clauth", "profiles", "god", "runtime-1-0"))
	if out := ta.hook(t, "UserPromptSubmit", prompt); out != "" {
		t.Fatalf("an uncovered profile must not be blocked: %s", out)
	}
	if api.hitCount("/report") != 0 {
		t.Fatal("an uncovered profile must not report")
	}
	ta.In = strings.NewReader(`{"rate_limits":{"seven_day":{"used_percentage":70,"resets_at":4102444800}}}`)
	ta.out.Reset()
	ta.run([]string{"statusline"})
	if fileExists(ta.statePath("reading.json")) || strings.Contains(ta.out.String(), "clare ·") {
		t.Fatalf("another account's meter must not be read: %q", ta.out.String())
	}

	// pranav: enforced as usual.
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".clauth", "profiles", "pranav", "runtime-2-0"))
	if out := ta.hook(t, "UserPromptSubmit", prompt); !strings.Contains(out, `"decision":"block"`) {
		t.Fatalf("the covered profile is enforced: %s", out)
	}
}

func TestProfileCommandAndEnrollFlag(t *testing.T) {
	api := newFakeAPI(t)
	ta := newTestApp(t)
	if code := ta.run([]string{"enroll", "k3F9", "--api", api.srv.URL, "--no-browser", "--profile", "pranav"}); code != 0 {
		t.Fatalf("enroll: %s", ta.out.String())
	}
	cfg, _ := ta.loadConfig()
	if strings.Join(cfg.Profiles, ",") != "pranav" || !strings.Contains(ta.out.String(), "Only these Claude Code profiles are covered: pranav") {
		t.Fatalf("profiles %v: %s", cfg.Profiles, ta.out.String())
	}
	// Re-enrolling without the flag keeps the choice.
	ta.run([]string{"enroll", "k3F9", "--api", api.srv.URL, "--no-browser"})
	if cfg, _ = ta.loadConfig(); strings.Join(cfg.Profiles, ",") != "pranav" {
		t.Fatalf("lost on re-enroll: %v", cfg.Profiles)
	}

	ta.out.Reset()
	ta.run([]string{"profile", "pranav,work"})
	if cfg, _ = ta.loadConfig(); strings.Join(cfg.Profiles, ",") != "pranav,work" {
		t.Fatalf("%v", cfg.Profiles)
	}
	ta.run([]string{"profile", "--all"})
	if cfg, _ = ta.loadConfig(); len(cfg.Profiles) != 0 {
		t.Fatalf("--all must clear: %v", cfg.Profiles)
	}
	ta.out.Reset()
	ta.run([]string{"profile"})
	if !strings.Contains(ta.out.String(), "every Claude Code profile") {
		t.Fatal(ta.out.String())
	}
}
