package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

// clauth links every profile's projects folder to one place, so one chat can move between
// accounts and keep its transcript. Only what it said while in a covered profile counts.
func TestChatsMovingBetweenProfilesCountOnlyTheirTimeHere(t *testing.T) {
	api := newFakeAPI(t)
	ta := newTestApp(t)
	cfg := ta.install(t, api.srv.URL)
	cfg.Profiles = []string{"pranav"}
	_ = ta.saveConfig(cfg)

	root := t.TempDir()
	shared := filepath.Join(root, ".claude", "projects")
	runtime := func(profile string) string {
		dir := filepath.Join(root, ".clauth", "profiles", profile, "runtime-1-0")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(shared, filepath.Join(dir, "projects")); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	god, pranav := runtime("god"), runtime("pranav")
	transcript := filepath.Join(shared, "-proj", "s.jsonl")
	subagent := filepath.Join(shared, "-proj", "s", "subagents", "agent-a.jsonl")
	in := func(rt, id string) map[string]any {
		t.Setenv("CLAUDE_CONFIG_DIR", rt)
		return map[string]any{"session_id": id, "transcript_path": filepath.Join(rt, "projects", "-proj", id+".jsonl")}
	}
	start := ta.clock
	at := func(d time.Duration) time.Time { return start.Add(d) }

	// Used in god for a while (another account).
	ta.hook(t, "SessionStart", in(god, "s"))
	writeFile(t, transcript, assistantLine("god1", "claude-opus-5-5", 1, 100, 0, 0, 0, at(-30*time.Minute))+
		assistantLine("god2", "claude-opus-5-5", 1, 100, 0, 0, 0, at(-10*time.Minute)))
	writeFile(t, subagent, assistantLine("godsub", "claude-haiku-5-5", 1, 100, 0, 0, 0, at(-5*time.Minute)))
	ta.hook(t, "Stop", in(god, "s"))

	// Resumed in pranav: its history is god's, only new replies count.
	ta.hook(t, "SessionStart", in(pranav, "s"))
	appendFile(t, transcript, assistantLine("p1", "claude-opus-5-5", 1, 10, 0, 0, 0, at(time.Minute)))
	appendFile(t, subagent, assistantLine("psub", "claude-haiku-5-5", 1, 10, 0, 0, 0, at(time.Minute)))
	ta.clock = at(2 * time.Minute)
	ta.hook(t, "Stop", in(pranav, "s"))

	// One more reply, then the window closes without a Stop and the chat goes back to god.
	appendFile(t, transcript, assistantLine("p2", "claude-opus-5-5", 1, 10, 0, 0, 0, at(3*time.Minute)))
	ta.clock = at(5 * time.Minute)
	ta.hook(t, "SessionStart", in(god, "s"))
	appendFile(t, transcript, assistantLine("god3", "claude-opus-5-5", 1, 100, 0, 0, 0, at(6*time.Minute)))

	// Another pranav chat re-checks every transcript it knows: p2 is caught up, god3 isn't counted.
	ta.clock = at(10 * time.Minute)
	ta.hook(t, "SessionStart", in(pranav, "other"))

	var keys []string
	for _, e := range api.events {
		keys = append(keys, e.Key)
	}
	if got := strings.Join(keys, " "); got != "cc:p1 cc:psub cc:p2" {
		t.Fatalf("reported %q, want only the replies made in pranav", got)
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
