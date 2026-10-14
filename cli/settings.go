package main

import (
	"encoding/json"
	"os"
)

// The managed-settings drop-in that wires clare into every local Claude Code
// surface (any terminal, VS Code, JetBrains, the desktop app). Living in
// managed-settings.d means we never touch an existing managed-settings.json,
// and hook lists from different files are combined by Claude Code. The managed
// statusLine wins over yours, so `clare statusline` runs yours for you.

type hookCommand struct {
	Type    string   `json:"type"`
	Command string   `json:"command"`
	Args    []string `json:"args"`
	Timeout int      `json:"timeout"`
}

type hookGroup struct {
	Matcher string        `json:"matcher,omitempty"`
	Hooks   []hookCommand `json:"hooks"`
}

type statusLineSetting struct {
	Type    string `json:"type"`
	Command string `json:"command"`
}

type dropInSettings struct {
	Schema                string                 `json:"$schema"`
	AllowManagedHooksOnly bool                   `json:"allowManagedHooksOnly,omitempty"`
	Hooks                 map[string][]hookGroup `json:"hooks"`
	StatusLine            statusLineSetting      `json:"statusLine"`
}

// hookEvents lists the Claude Code events clare listens to and each hook's
// timeout in seconds (our own network calls time out well before these).
var hookEvents = []struct {
	Event   string
	Matcher string
	Timeout int
}{
	{"SessionStart", "", 15},
	{"UserPromptSubmit", "", 10},
	{"PreToolUse", "*", 8},
	{"Stop", "", 15},
	{"SubagentStop", "", 15},
	{"SessionEnd", "", 15},
}

// renderDropIn builds the drop-in JSON. Hooks use exec form (command + args)
// with an absolute path, so there is no shell quoting and no PATH lookup —
// this is what makes it work inside VS Code launched from the Dock. The status
// line is a shell command, so its path is quoted (it contains spaces on macOS
// and Windows).
func renderDropIn(binPath string, strict bool) []byte {
	s := dropInSettings{
		Schema:                "https://json.schemastore.org/claude-code-settings.json",
		AllowManagedHooksOnly: strict,
		Hooks:                 map[string][]hookGroup{},
		StatusLine:            statusLineSetting{Type: "command", Command: `"` + binPath + `" statusline`},
	}
	for _, e := range hookEvents {
		s.Hooks[e.Event] = []hookGroup{{
			Matcher: e.Matcher,
			Hooks: []hookCommand{{
				Type:    "command",
				Command: binPath,
				Args:    []string{"hook", e.Event},
				Timeout: e.Timeout,
			}},
		}}
	}
	data, _ := json.MarshalIndent(s, "", "  ")
	return append(data, '\n')
}

func (a *App) writeDropIn(strict bool) error {
	return writeFileAtomic(a.dropInPath(), renderDropIn(a.binPath(), strict), 0o644)
}

// dropInHealthy reports whether the drop-in on disk is exactly what we expect.
func (a *App) dropInHealthy(strict bool) bool {
	data, err := os.ReadFile(a.dropInPath())
	if err != nil {
		return false
	}
	return jsonEqual(data, renderDropIn(a.binPath(), strict))
}
