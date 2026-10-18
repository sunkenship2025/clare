package main

import (
	"errors"
	"os"
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

	a.doctorMeter(u, cfg, resp.Status)

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

// doctorMeter says whether Claude's usage meter is being read, by any device and by this one, and
// what to do when it isn't: usage on devices without clare only shows up through the meter.
func (a *App) doctorMeter(u *ui, cfg *Config, st *Status) {
	now := a.Now()
	account, read := st.meterAge(now)
	fresh := read && account < meterStaleAfter
	switch {
	case fresh:
		u.ok("Claude's usage meter was read " + ago(account))
	case read:
		u.warn("Claude's usage meter was last read " + ago(account) + ", so usage on devices without clare isn't counted yet")
	case st != nil && st.Basis == "estimate":
		u.line("  %s Claude's usage meter hasn't been read yet this week, so clare is estimating", u.dim("·"))
	}

	here, ok := a.userReading().age(now)
	switch {
	case ok && here < meterAlertAfter:
		u.ok("Claude Code on this computer read it " + ago(here))
		return
	case fresh:
		u.line("  %s Claude Code on this computer hasn't read it lately, but another device has", u.dim("·"))
		return
	case ok:
		u.warn("Claude Code on this computer last read it " + ago(here))
	default:
		u.warn("Claude Code on this computer hasn't read it yet")
	}
	u.line("    It's read after each Claude reply in a terminal, on Pro and Max plans. Claude Code in")
	u.line("    VS Code or the desktop app may not pass it to clare. Use Claude Code in a terminal now")
	u.line("    and then, or open claude.ai in Chrome with the clare extension.")
	if len(cfg.Profiles) > 0 {
		u.line("    Only these Claude Code profiles count: %s.", strings.Join(cfg.Profiles, ", "))
	}
}

// userReading is the newest meter reading this computer's status line saved. Under sudo that's
// in the invoking user's cache, not root's.
func (a *App) userReading() *Reading {
	if sudoUser() != "" && !a.TestMode && os.Getenv("CLARE_STATE_DIR") == "" {
		return loadReadingFile(filepath.Join(stateDirIn(a.GOOS, invokingHome(a.GOOS)), "reading.json"))
	}
	return a.loadReading()
}

// sentence capitalises a short phrase and ends it with a period.
func sentence(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:] + "."
}
