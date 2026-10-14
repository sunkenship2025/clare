package main

import (
	"bufio"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type enrollFlags struct {
	code, api, web, label string
	pause, noBrowser      bool
}

// parseEnrollArgs accepts the code before or after flags, and a whole pasted
// enroll link instead of a bare code.
func parseEnrollArgs(args []string) enrollFlags {
	var f enrollFlags
	for i := 0; i < len(args); i++ {
		arg := args[i]
		name, val, hasVal := strings.Cut(strings.TrimLeft(arg, "-"), "=")
		if !strings.HasPrefix(arg, "-") {
			if f.code == "" {
				f.code = arg
			}
			continue
		}
		next := func() string {
			if hasVal {
				return val
			}
			if i+1 < len(args) {
				i++
				return args[i]
			}
			return ""
		}
		switch name {
		case "api":
			f.api = next()
		case "web":
			f.web = next()
		case "label":
			f.label = next()
		case "pause":
			f.pause = true
		case "no-browser":
			f.noBrowser = true
		}
	}
	f.code = normalizeCode(f.code)
	if strings.Contains(f.api, "__CLARE_") {
		f.api = ""
	}
	if strings.Contains(f.web, "__CLARE_") {
		f.web = ""
	}
	return f
}

// normalizeCode turns "https://x/enroll.html#k3F9" or "code=k3F9" into "k3F9".
func normalizeCode(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndex(s, "#"); i >= 0 {
		s = s[i+1:]
	}
	s = strings.TrimPrefix(s, "code=")
	return strings.Trim(s, " /\"'")
}

func (a *App) runEnroll(args []string) int {
	f := parseEnrollArgs(args)
	u := newUI(a.Out)
	defer func() {
		if f.pause {
			u.blank()
			u.line("  Press Enter to close this window.")
			bufio.NewReader(a.In).ReadString('\n')
		}
	}()

	u.blank()
	if f.code == "" {
		u.fail("The enroll code is missing.")
		u.line("    In your clare dashboard, choose \"Add a device\" and copy the command from there.")
		u.blank()
		return 1
	}
	if !a.isRoot() {
		u.fail("clare needs administrator rights to set up Claude Code's managed settings.")
		if a.GOOS == "windows" {
			u.line("    Run this again from a PowerShell window opened with \"Run as administrator\".")
		} else {
			u.line("    Run it again with sudo in front:")
			u.line("      sudo clare enroll %s", f.code)
		}
		u.blank()
		return 1
	}

	old, _ := a.loadConfig()
	api := firstNonEmpty(f.api, defaultAPI)
	web := firstNonEmpty(f.web, defaultWeb)
	if old != nil {
		api = firstNonEmpty(api, old.API)
		web = firstNonEmpty(web, old.Web)
	}
	api = strings.TrimRight(api, "/")
	web = strings.TrimRight(web, "/")
	if api == "" {
		u.fail("This installer doesn't know where your clare server is.")
		u.line("    Copy the install command again from \"Add a device\" in your clare dashboard.")
		u.blank()
		return 1
	}

	u.line("  Enrolling this computer in clare…")

	label := firstNonEmpty(f.label, computerName(a.GOOS))
	cfg := &Config{API: api, Web: web, MachineID: machineID(a.GOOS)}
	var resp enrollResponse
	err := a.client(api, "").call(20*time.Second, "POST", "/enroll", enrollRequest{
		Code: f.code, Kind: "cli", Label: label, Info: a.deviceInfo(cfg),
	}, &resp)
	if err != nil {
		u.blank()
		a.explainEnrollError(u, err)
		u.blank()
		return 1
	}

	// Moving this computer to a different clare server: tell the old one it's gone.
	// (Re-enrolling on the same server replaces the old device there automatically.)
	sameServer := old != nil && old.API == api
	if old != nil && old.Token != "" && !sameServer {
		_ = a.client(old.API, old.Token).call(5*time.Second, "POST", "/device/remove", map[string]any{"reason": "moved to another clare server"}, nil)
	}

	cfg.Token = resp.Token
	cfg.DeviceID = resp.DeviceID
	cfg.Label = label
	cfg.EnrolledAt = a.Now().UTC().Format(time.RFC3339)
	cfg.Version = version
	if resp.Status != nil {
		cfg.StrictHooks = resp.Status.StrictHooks
		if resp.Status.Device != nil && resp.Status.Device.Label != "" {
			cfg.Label = resp.Status.Device.Label
		}
	}
	if sameServer && old.EnrolledAt != "" {
		cfg.EnrolledAt = old.EnrolledAt // re-install: keep counting from the original enrollment
	}

	if err := a.installFiles(cfg); err != nil {
		u.blank()
		u.fail("clare couldn't finish setting up on this computer.")
		u.line("    %s", err)
		u.line("    Try the command again. If it keeps failing, run:  sudo clare doctor")
		u.blank()
		return 1
	}
	if resp.Status != nil {
		_ = writeJSONAtomic(a.systemStatusPath(), statusCache{Status: resp.Status, FetchedAt: a.Now()}, 0o644)
	}

	u.blank()
	u.ok(fmt.Sprintf("This computer is enrolled as %s.", u.bold(cfg.Label)))
	u.ok("Claude Code here now reports its usage and follows your weekly budget: every terminal, VS Code, JetBrains, and the desktop app.")
	if !claudeInstalled(a.GOOS) {
		u.line("    %s", u.dim("(Claude Code isn't installed yet. It's covered as soon as you install it.)"))
	}
	if st := resp.Status; st != nil {
		line := fmt.Sprintf("This week: %s of your budget used", fmtPct(st.Account.Pct))
		if t, ok := st.resetsAt(); ok {
			line += ", resets " + friendlyTime(t, a.Now())
		}
		u.ok(line + ".")
	}
	u.blank()
	u.line("  If Claude Code is open right now, restart it.")
	u.line("  To see usage any time, type:  %s", u.cyan("clare status"))

	if !f.noBrowser && web != "" && chromiumInstalled(a.GOOS) {
		link := web + "/enroll.html#" + f.code
		u.blank()
		u.line("  Using claude.ai in Chrome too? Add the browser extension from the enroll page:")
		u.line("  %s", u.dim(link))
		a.openBrowserAsUser(link)
	}
	u.blank()
	return 0
}

// installFiles puts everything in place: binary, config, drop-in, backup, watchdog.
func (a *App) installFiles(cfg *Config) error {
	if err := os.MkdirAll(a.clareDir(), 0o755); err != nil {
		return err
	}
	_ = os.Chmod(a.clareDir(), 0o755)

	self, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(self); err == nil {
		self = resolved
	}
	if target, _ := filepath.Abs(a.binPath()); self != target {
		if err := copyFile(self, a.binPath(), 0o755); err != nil {
			return fmt.Errorf("copying clare into place: %w", err)
		}
	}
	if err := a.saveConfig(cfg); err != nil {
		return fmt.Errorf("saving settings: %w", err)
	}
	if err := a.writeDropIn(cfg.StrictHooks); err != nil {
		return fmt.Errorf("connecting to Claude Code: %w", err)
	}
	if err := a.writeBackup(); err != nil {
		return fmt.Errorf("saving a backup: %w", err)
	}
	if !a.NoService {
		if err := a.installService(); err != nil {
			return fmt.Errorf("starting the background helper: %w", err)
		}
		a.installSymlink()
	}
	return nil
}

// writeBackup copies the files the watchdog guards into a root-only folder.
func (a *App) writeBackup() error {
	dir := a.backupDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	_ = os.Chmod(dir, 0o700)
	for src, name := range map[string]string{
		a.binPath():    a.binName(),
		a.configPath(): "config.json",
		a.dropInPath(): "50-clare.json",
	} {
		perm := os.FileMode(0o600)
		if name == a.binName() {
			perm = 0o700
		}
		if err := copyFile(src, filepath.Join(dir, name), perm); err != nil {
			return err
		}
	}
	sum, err := sha256File(a.binPath())
	if err != nil {
		return err
	}
	return writeJSONAtomic(filepath.Join(dir, "checksums.json"), map[string]string{"binary": sum}, 0o600)
}

func (a *App) explainEnrollError(u *ui, err error) {
	switch code := apiErrorCode(err); {
	case isOffline(err):
		u.fail("Couldn't reach the clare server. Check your internet connection and try again.")
	case code == "expired_code" || code == "expired":
		u.fail("This enroll link has expired.")
		u.line("    In your clare dashboard, choose \"Add a device\" to get a new one.")
	case code == "invalid_code" || code == "not_found":
		u.fail("This enroll code isn't valid.")
		u.line("    Make sure you copied the whole command, or get a new one from \"Add a device\" in the dashboard.")
	default:
		u.fail("clare couldn't enroll this computer.")
		u.line("    %s", err)
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func round1(f float64) float64 {
	return math.Round(f*10) / 10
}

// fmtPct prints a percentage with at most one decimal: "46%", "12.5%".
func fmtPct(f float64) string {
	return strconv.FormatFloat(round1(f), 'f', -1, 64) + "%"
}
