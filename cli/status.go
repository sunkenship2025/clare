package main

import (
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

func (a *App) runStatus() int {
	u := newUI(a.Out)
	u.blank()

	cfg, err := a.loadConfig()
	if errors.Is(err, errNotInstalled) {
		u.line("  clare isn't set up on this computer yet.")
		u.line("  To add it, open your clare dashboard and choose \"Add a device\".")
		u.blank()
		return 1
	}
	if err != nil {
		u.fail("clare's settings on this computer look damaged.")
		u.line("    To fix it, type:  sudo clare doctor")
		u.blank()
		return 1
	}

	var resp statusResponse
	err = a.client(cfg.API, cfg.Token).call(6*time.Second, "POST", "/check", map[string]any{}, &resp)
	cache := a.loadStatusCache()
	st := resp.Status
	online := err == nil && st != nil
	switch {
	case online:
		cache.Status, cache.FetchedAt, cache.Revoked = st, a.Now(), false
		a.saveStatusCache(cache)
	case isRevoked(err):
		u.fail("This computer was removed from clare in the dashboard.")
		u.line("    clare uninstalls itself within a few minutes. To add it back, use \"Add a device\" in the dashboard.")
		u.blank()
		return 1
	case isUnauthorized(err):
		u.fail("The clare server doesn't recognise this computer.")
		u.line("    Enroll it again: in the dashboard choose \"Add a device\" and run the command it shows.")
		u.blank()
		return 1
	default:
		st = cache.Status
	}

	label := cfg.Label
	if st != nil && st.Device != nil && st.Device.Label != "" {
		label = st.Device.Label
	}
	u.line("  %s %s", u.bold("clare"), u.dim("· "+firstNonEmpty(label, "this computer")))
	u.blank()

	if st == nil {
		u.warn("Can't reach the clare server right now, and there's nothing saved yet.")
		u.line("    Check your internet connection and try again.")
		u.blank()
		return 1
	}

	paint := u.green
	switch st.State {
	case "warn", "over":
		paint = u.yellow
	case "blocked":
		paint = u.red
	}
	about := ""
	if st.Basis == "estimate" {
		about = "about "
	}
	whose := "of your budget"
	switch {
	case st.Scope == "device":
		whose = "of this device's budget"
	case st.Scope == "group" && st.Group != nil:
		whose = "of " + groupPhrase(st.Group.Label) + "'s share"
	}

	const row = "  %-12s %s"
	u.line(row+"  %s", "This week", paint(bar(st.Pct, 20)), paint(fmt.Sprintf("%s%.0f%% %s", about, st.Pct, whose)))
	u.line(row, "Account", fmt.Sprintf("%s%s of the weekly limit used · budget %s", about, fmtPct(st.Account.Used), fmtPct(st.Account.Budget)))
	if g := st.Group; g != nil {
		u.line(row, "Group", fmt.Sprintf("%s · %s%s of its %s share", g.Label, about, fmtPct(g.Used), fmtPct(g.Budget)))
	}
	if d := st.Device; d != nil {
		line := fmt.Sprintf("%s%s of the weekly limit", about, fmtPct(d.Used))
		if d.Budget != nil {
			line += " · cap " + fmtPct(*d.Budget)
		}
		u.line(row, "This device", line)
	}
	if t, ok := st.resetsAt(); ok {
		u.line(row, "Resets", friendlyTime(t, a.Now()))
	}
	if st.Basis == "estimate" {
		u.line(row, "Measured by", "estimate (no official usage reading yet this week)")
	} else {
		u.line(row, "Measured by", "Claude's official usage meter")
	}
	if st.Enforce {
		u.line(row, "Budget", "enforced (Claude Code stops when it's used up)")
	} else {
		u.line(row, "Budget", u.yellow("monitor only (nothing is blocked)"))
	}
	if len(cfg.Profiles) > 0 {
		u.line(row, "Profiles", strings.Join(cfg.Profiles, ", ")+" only")
	}
	if online {
		u.line(row, "Connection", u.green("✓ Connected"))
	} else {
		u.line(row, "Connection", u.yellow("Offline — showing what clare knew "+ago(a.Now().Sub(cache.FetchedAt))))
	}

	if st.State != "ok" && st.Message != "" {
		u.blank()
		u.line("  %s", paint(st.Message))
	}
	u.blank()
	return 0
}

func (a *App) runDashboard() int {
	u := newUI(a.Out)
	u.blank()
	cfg, err := a.loadConfig()
	if err != nil {
		u.line("  clare isn't set up on this computer yet.")
		u.line("  To add it, open your clare dashboard and choose \"Add a device\".")
		u.blank()
		return 1
	}
	if cfg.Web == "" {
		u.fail("clare doesn't know your dashboard's address.")
		u.line("    Enroll this computer again with the command from \"Add a device\" (it includes the address).")
		u.blank()
		return 1
	}

	var resp loginLinkResponse
	if err := a.client(cfg.API, cfg.Token).call(10*time.Second, "POST", "/login-link", map[string]any{}, &resp); err != nil {
		if isOffline(err) {
			u.fail("Couldn't reach the clare server. Check your internet connection and try again.")
		} else {
			u.fail("Couldn't open your dashboard: " + err.Error())
		}
		u.blank()
		return 1
	}
	url := strings.TrimRight(cfg.Web, "/") + "/dash.html#login=" + resp.Code
	if a.openBrowserAsUser(url) {
		u.ok("Opening your clare dashboard in the browser…")
	} else {
		u.line("  Open this link in your browser (it works once, for 10 minutes):")
	}
	u.line("  %s", u.dim(url))
	u.blank()
	return 0
}

func openBrowser(goos, url string) bool {
	var cmd *exec.Cmd
	switch goos {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start() == nil
}
