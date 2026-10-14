package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRenderDropIn(t *testing.T) {
	bin := "/Library/Application Support/ClaudeCode/clare/clare"
	var s map[string]any
	if err := json.Unmarshal(renderDropIn(bin, true), &s); err != nil {
		t.Fatal(err)
	}
	if s["allowManagedHooksOnly"] != true {
		t.Fatal("strict mode must set allowManagedHooksOnly")
	}
	hooks := s["hooks"].(map[string]any)
	for _, ev := range []string{"SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "SubagentStop", "SessionEnd"} {
		groups, ok := hooks[ev].([]any)
		if !ok || len(groups) != 1 {
			t.Fatalf("missing %s", ev)
		}
		h := groups[0].(map[string]any)["hooks"].([]any)[0].(map[string]any)
		args := h["args"].([]any)
		if h["type"] != "command" || h["command"] != bin || args[0] != "hook" || args[1] != ev {
			t.Fatalf("%s hook wrong: %v", ev, h)
		}
	}
	if m := hooks["PreToolUse"].([]any)[0].(map[string]any)["matcher"]; m != "*" {
		t.Fatalf("PreToolUse matcher = %v", m)
	}
	sl, _ := s["statusLine"].(map[string]any)
	if sl["type"] != "command" || sl["command"] != `"`+bin+`" statusline` {
		t.Fatalf("statusLine must run clare with a quoted absolute path: %v", sl)
	}

	var loose map[string]any
	_ = json.Unmarshal(renderDropIn(bin, false), &loose)
	if _, ok := loose["allowManagedHooksOnly"]; ok {
		t.Fatal("non-strict mode must not set allowManagedHooksOnly")
	}
}

func TestWriteDropInAtomicAndHealthy(t *testing.T) {
	ta := newTestApp(t)
	if err := ta.writeDropIn(true); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(ta.dropInDir())
	if len(entries) != 1 || entries[0].Name() != "50-clare.json" {
		t.Fatalf("leftover temp files: %v", entries)
	}
	if !ta.dropInHealthy(true) || ta.dropInHealthy(false) {
		t.Fatal("health check mismatch")
	}

	// Tampering is detected and repaired.
	os.WriteFile(ta.dropInPath(), []byte(`{"hooks":{}}`), 0o644)
	cfg := &Config{StrictHooks: true}
	if p := ta.checkIntegrity(cfg, true); len(p) == 0 {
		t.Fatal("tamper not detected")
	}
	if !ta.dropInHealthy(true) {
		t.Fatal("tamper not repaired")
	}
}

func TestWriteFileAtomicReplaces(t *testing.T) {
	p := filepath.Join(t.TempDir(), "a", "b.json")
	if err := writeFileAtomic(p, []byte(`{"v":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeFileAtomic(p, []byte(`{"v":2}`), 0o644); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	if !strings.Contains(string(b), "2") {
		t.Fatalf("got %s", b)
	}
}

func TestParseEnrollArgs(t *testing.T) {
	f := parseEnrollArgs([]string{"--api", "https://x/api", "https://me.github.io/clare/enroll.html#k3F9xx", "--web=https://w", "--pause", "--no-browser", "--label", "Work Mac"})
	if f.code != "k3F9xx" || f.api != "https://x/api" || f.web != "https://w" || !f.pause || !f.noBrowser || f.label != "Work Mac" {
		t.Fatalf("%+v", f)
	}
	f = parseEnrollArgs([]string{"abc", "--api", "__CLARE_API_URL__"})
	if f.code != "abc" || f.api != "" || f.noBrowser {
		t.Fatalf("placeholder must be ignored: %+v", f)
	}
}
