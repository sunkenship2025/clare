package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// `clare statusline` is Claude Code's managed status line. Claude Code pipes it a
// JSON payload after each assistant message; on Pro/Max plans that payload carries
// the official usage meter in `rate_limits`. clare saves that reading (sent with the
// next hook's /report), runs your own status line so you don't lose it, and adds
// one short line. No network, never fails.

type statusLineInput struct {
	Cwd       string `json:"cwd"`
	Workspace struct {
		CurrentDir string `json:"current_dir"`
		ProjectDir string `json:"project_dir"`
	} `json:"workspace"`
	RateLimits map[string]json.RawMessage `json:"rate_limits"`
}

const userStatusLineTimeout = 3 * time.Second

func (a *App) runStatusLine() int {
	data, _ := io.ReadAll(io.LimitReader(a.In, 4<<20))
	var in statusLineInput
	_ = json.Unmarshal(data, &in)

	// In a profile clare doesn't cover, only your own status line shows: that profile's
	// meter may belong to a different Claude account.
	cfg, _ := a.loadConfig()
	covered := cfg.profileCovered()
	if r := parseRateLimits(in.RateLimits, a.Now()); r != nil && covered {
		if os.MkdirAll(a.StateDir, 0o700) == nil {
			_ = writeJSONAtomic(a.statePath("reading.json"), r, 0o600)
		}
	}

	project := firstNonEmpty(in.Workspace.ProjectDir, in.Cwd, in.Workspace.CurrentDir)
	if cmd := a.userStatusLine(project); cmd != "" {
		dir := firstNonEmpty(in.Cwd, in.Workspace.CurrentDir, project)
		if out := runUserStatusLine(a.GOOS, cmd, dir, data); out != "" {
			fmt.Fprintln(a.Out, out)
		}
	}
	if line := a.statusLineText(); covered && line != "" {
		fmt.Fprintln(a.Out, line)
	}
	return 0
}

// userStatusLine finds your own statusLine command, most specific settings first:
// the project's settings.local.json, the project's settings.json, then your user
// settings. clare's own command is skipped so it never runs itself.
func (a *App) userStatusLine(project string) string {
	var files []string
	if project != "" {
		files = append(files,
			filepath.Join(project, ".claude", "settings.local.json"),
			filepath.Join(project, ".claude", "settings.json"))
	}
	if dir := os.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
		files = append(files, filepath.Join(dir, "settings.json"))
	} else if home, err := os.UserHomeDir(); err == nil {
		files = append(files, filepath.Join(home, ".claude", "settings.json"))
	}
	for _, f := range files {
		var s struct {
			StatusLine *struct {
				Type    string `json:"type"`
				Command string `json:"command"`
			} `json:"statusLine"`
		}
		if readJSONFile(f, &s) != nil || s.StatusLine == nil {
			continue
		}
		cmd := strings.TrimSpace(s.StatusLine.Command)
		if cmd == "" || (s.StatusLine.Type != "" && s.StatusLine.Type != "command") || a.isClareStatusLine(cmd) {
			continue
		}
		return cmd
	}
	return ""
}

var clareStatusLineRe = regexp.MustCompile(`(?i)(^|[\s/\\"'])clare(\.exe)?["']?\s+statusline\b`)

func (a *App) isClareStatusLine(cmd string) bool {
	return clareStatusLineRe.MatchString(cmd) || strings.Contains(cmd, a.binPath())
}

// runUserStatusLine runs a status line command through the shell with the same
// stdin Claude Code gave us, and returns its output without the final newline.
func runUserStatusLine(goos, command, dir string, stdin []byte) string {
	ctx, cancel := context.WithTimeout(context.Background(), userStatusLineTimeout)
	defer cancel()
	var cmd *exec.Cmd
	switch {
	case goos != "windows":
		cmd = exec.CommandContext(ctx, "sh", "-c", command)
	default:
		if bash, err := exec.LookPath("bash"); err == nil {
			cmd = exec.CommandContext(ctx, bash, "-c", command)
		} else {
			cmd = exec.CommandContext(ctx, "cmd", "/C", command)
		}
	}
	if st, err := os.Stat(dir); dir != "" && err == nil && st.IsDir() {
		cmd.Dir = dir
	}
	cmd.Stdin = bytes.NewReader(stdin)
	cmd.Stderr = io.Discard
	cmd.WaitDelay = 500 * time.Millisecond // don't hang on a background child holding the pipe
	out, _ := cmd.Output()
	return strings.TrimRight(string(out), "\r\n")
}

// statusLineText is clare's own line, from the last status a hook fetched.
func (a *App) statusLineText() string {
	cache := a.loadStatusCache()
	st := cache.Status
	if cache.Revoked || st == nil {
		return ""
	}
	if t, ok := st.resetsAt(); ok && !a.Now().Before(t) {
		return "" // last week's numbers
	}
	whose := "weekly budget"
	switch {
	case st.Scope == "device":
		whose = "this device's weekly budget"
	case st.Scope == "group" && st.Group != nil:
		whose = groupPhrase(st.Group.Label) + "'s weekly share"
	}
	// An old meter reading may be missing usage elsewhere, so say how old it is.
	stale := ""
	if age, ok := st.meterAge(a.Now()); ok && st.Basis == "meter" && age >= meterStaleAfter {
		stale = " · meter read " + shortAgo(age)
	}
	if st.State == "blocked" {
		return "clare · " + whose + " used up" + stale
	}
	approx := ""
	if st.Basis == "estimate" {
		approx = "~"
	}
	return fmt.Sprintf("clare · %s%.0f%% of %s%s", approx, math.Floor(math.Max(0, st.Pct)), whose, stale)
}

// shortAgo: "3h ago", "2d ago", for the status line.
func shortAgo(d time.Duration) string {
	if d < 48*time.Hour {
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	}
	return fmt.Sprintf("%dd ago", int(d.Hours()/24))
}
