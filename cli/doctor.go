package main

import (
	"errors"
	"path/filepath"
	"strings"
	"time"
)

// runDoctor checks the install and, when run with sudo, repairs it.
func (a *App) runDoctor() int {
	u := newUI(a.Out)
	root := a.isRoot()
	u.blank()
	u.line("  %s %s", u.bold("clare doctor"), u.dim("· checking this computer"))
	u.blank()

	cfg, err := a.loadConfig()
	if err != nil && root {
		// Try the backup before giving up.
		if copyFile(filepath.Join(a.backupDir(), "config.json"), a.configPath(), 0o644) == nil {
			cfg, err = a.loadConfig()
			if err == nil {
				u.ok("Restored clare's settings from the backup.")
			}
		}
	}
	switch {
	case errors.Is(err, errNotInstalled):
		u.fail("clare isn't set up on this computer.")
		u.line("    To add it, open your clare dashboard and choose \"Add a device\".")
		u.blank()
		return 1
	case err != nil:
		u.fail("clare's settings are damaged and there's no backup to restore.")
		u.line("    Enroll this computer again: in the dashboard choose \"Add a device\".")
		u.blank()
		return 1
	}
	u.ok("Enrolled as " + u.bold(firstNonEmpty(cfg.Label, "this computer")))

	problems := a.checkIntegrity(cfg, root)
	if len(problems) == 0 {
		u.ok("Claude Code's hooks and status line are installed")
		u.ok("The background helper is running")
	} else {
		for _, p := range problems {
			p = sentence(p)
			if root {
				u.warn(p + " Fixed it where possible.")
			} else {
				u.fail(p)
			}
		}
		if root {
			_ = a.writeBackup()
		}
	}

	var resp statusResponse
	err = a.client(cfg.API, cfg.Token).call(8*time.Second, "POST", "/check", map[string]any{}, &resp)
	switch {
	case err == nil:
		u.ok("The clare server is reachable and knows this computer")
	case isRevoked(err):
		u.fail("This computer was removed from clare in the dashboard. To add it back, use \"Add a device\".")
	case isUnauthorized(err):
		u.fail("The clare server doesn't recognise this computer's sign-in. Enroll it again with \"Add a device\" in the dashboard.")
	case isOffline(err):
		u.warn("Can't reach the clare server right now (check the internet connection). Usage is saved and sent later.")
	default:
		u.fail("The server didn't accept this computer: " + err.Error())
	}

	if r := a.loadReading(); r != nil {
		u.ok("The status line is reading Claude's official usage meter")
	} else {
		u.line("  %s No official usage reading from the status line yet (it appears after a Claude reply on Pro/Max plans)", u.dim("·"))
	}

	if claudeInstalled(a.GOOS) {
		u.ok("Claude Code is installed")
	} else {
		u.line("  %s Claude Code isn't installed yet (that's fine — it's covered as soon as you install it)", u.dim("·"))
	}

	u.blank()
	if len(problems) > 0 && !root {
		u.line("  To fix these, type:  %s", u.cyan("sudo clare doctor"))
		u.blank()
		return 1
	}
	if len(problems) > 0 {
		u.line("  Fixed what could be fixed. If Claude Code is open, restart it.")
		u.blank()
	}
	return 0
}

// sentence capitalises a short phrase and ends it with a period.
func sentence(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:] + "."
}
