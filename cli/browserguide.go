package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"time"
)

// The browser guide walks through adding clare's extension to each Chromium browser on
// this computer, one at a time: open its extensions page, switch on Developer mode, load
// the extension folder, then open the enroll page in that browser so the extension
// connects itself. It runs at the end of `clare enroll` and on its own as `clare browser`.

var (
	extensionWait      = 90 * time.Second
	extensionPollEvery = 1500 * time.Millisecond
)

// tty is where the guide reads answers: the terminal, even when stdin is a pipe
// (`curl … | sh`). nil when there's no terminal to ask.
func (a *App) tty() *bufio.Reader {
	if a.TTY != nil {
		return bufio.NewReader(a.TTY)
	}
	if a.TestMode {
		return nil
	}
	if a.GOOS == "windows" {
		return bufio.NewReader(os.Stdin)
	}
	f, err := os.Open("/dev/tty")
	if err != nil {
		return nil
	}
	return bufio.NewReader(f)
}

func (a *App) runBrowserGuide(u *ui, cfg *Config, code string) {
	found := a.detectBrowsers()
	if len(found) == 0 || cfg.Web == "" {
		return
	}
	link := cfg.Web + "/enroll.html#" + code
	dir := a.extensionDir()

	u.blank()
	u.line("  %s", u.bold("Now your browsers"))
	u.line("  clare's browser extension counts claude.ai usage and holds Send when you're over budget.")
	if !a.extensionReady() {
		// A build without the bundled extension: the enroll page offers the download.
		u.line("  Add it from the enroll page:  %s", u.dim(link))
		a.openIn(found[0], link)
		return
	}
	names := make([]string, len(found))
	for i, b := range found {
		names[i] = b.Name
	}
	u.line("  Found %s.", joinAnd(names))

	in := a.tty()
	if in == nil {
		a.printAllBrowserSteps(u, found, dir, link)
		return
	}
	if len(found) > 1 {
		u.line("  One browser at a time, about 30 seconds each.")
	}
	for i, b := range found {
		u.blank()
		title := b.Name
		if len(found) > 1 {
			title = fmt.Sprintf("%s (%d of %d)", b.Name, i+1, len(found))
		}
		u.line("  %s", u.bold(title))
		a.openIn(b, b.Page)
		a.browserSteps(u, b, dir, i == 0)
		u.blank()
		fmt.Fprint(u.w, "  Press Enter once clare is in the list (s = skip this browser, q = stop): ")
		answer, err := in.ReadString('\n')
		if err != nil {
			// The terminal went away: leave the remaining steps on screen.
			u.blank()
			a.printAllBrowserSteps(u, found[i:], dir, link)
			return
		}
		switch strings.ToLower(strings.TrimSpace(answer)) {
		case "s", "skip":
			u.line("  Skipped %s.", b.Name)
			continue
		case "q", "quit", "stop":
			u.blank()
			u.line("  No problem. To add a browser later, run:  %s", u.cyan("clare browser"))
			return
		}
		a.connectBrowser(u, cfg, code, b, link)
	}
	u.blank()
	u.line("  To add another browser later, run:  %s", u.cyan("clare browser"))
}

// browserSteps prints the three steps for one browser. The first time it also shows the
// folder in Finder / Explorer; every time it puts the folder's path on the clipboard.
func (a *App) browserSteps(u *ui, b foundBrowser, dir string, first bool) {
	u.line("  1. In %s, go to %s (if it didn't open, paste that into the address bar).", b.Name, u.cyan(b.Page))
	u.line("  2. Turn on %s.", b.DevMode)
	u.line("  3. Click %s and choose this folder:", u.bold("Load unpacked"))
	u.line("       %s", dir)
	if first {
		a.revealFolder(dir)
	}
	if !a.copyText(dir) {
		return
	}
	switch a.GOOS {
	case "darwin":
		u.line("     %s", u.dim("The path is copied: in the file picker press ⌘⇧G, then ⌘V and Return."))
		u.line("     %s", u.dim("Or drag the folder from the Finder window onto the extensions page."))
	case "windows":
		u.line("     %s", u.dim("The path is copied: paste it into the Folder box (Ctrl+V)."))
	default:
		u.line("     %s", u.dim("The path is copied: in the file picker press Ctrl+L, then Ctrl+V."))
	}
}

// connectBrowser opens the enroll page in the browser, where the freshly loaded
// extension picks up the code and enrolls, and waits until the server has it.
func (a *App) connectBrowser(u *ui, cfg *Config, code string, b foundBrowser, link string) {
	before, err := a.enrolledExtensions(cfg.API, code)
	if !a.openIn(b, link) {
		u.line("  Now open this link in %s so clare can connect:", b.Name)
		u.line("    %s", link)
	}
	u.line("  Connecting clare in %s…", b.Name)
	if err == nil && a.waitForExtension(cfg.API, code, before) {
		u.ok(b.Name + " is connected.")
		return
	}
	u.warn(fmt.Sprintf("clare hasn't heard from %s yet.", b.Name))
	u.line("    If clare's toolbar icon shows your weekly budget, it's connected. (Pin it from the puzzle-piece menu.)")
	u.line("    If it says Not connected, click it and paste this code:  %s", u.bold(code))
}

// enrolledExtensions counts the browsers enrolled with this code so far.
func (a *App) enrolledExtensions(api, code string) (int, error) {
	var resp struct {
		Devices []struct {
			Kind string `json:"kind"`
		} `json:"devices"`
	}
	if err := a.client(api, "").call(5*time.Second, "GET", "/enroll/"+code, nil, &resp); err != nil {
		return 0, err
	}
	n := 0
	for _, d := range resp.Devices {
		if d.Kind == "extension" {
			n++
		}
	}
	return n, nil
}

func (a *App) waitForExtension(api, code string, before int) bool {
	deadline := time.Now().Add(extensionWait)
	for time.Now().Before(deadline) {
		time.Sleep(extensionPollEvery)
		n, err := a.enrolledExtensions(api, code)
		if err != nil && !isOffline(err) {
			return false // the code expired or is gone: waiting won't help
		}
		if n > before {
			return true
		}
	}
	return false
}

// printAllBrowserSteps is the non-interactive version: every browser's steps at once.
func (a *App) printAllBrowserSteps(u *ui, found []foundBrowser, dir, link string) {
	u.line("  For each browser:")
	for _, b := range found {
		u.line("    %s: go to %s, turn on %s,", u.bold(b.Name), u.cyan(b.Page), b.DevMode)
		u.line("      click Load unpacked and choose %s", dir)
	}
	u.line("  Then open this link in each of them so clare can connect:")
	u.line("    %s", link)
}

// runBrowser is `clare browser`: the browser guide on its own, for a browser added later.
func (a *App) runBrowser() int {
	u := newUI(a.Out)
	u.blank()
	cfg, err := a.loadConfig()
	if err != nil {
		u.fail("This computer isn't enrolled in clare yet.")
		u.line("    In your clare dashboard, choose \"Add a device\" and run the command it shows.")
		u.blank()
		return 1
	}
	if !a.extensionReady() && a.extFS() != nil {
		if !a.isRoot() {
			u.fail("The browser extension's folder is missing on this computer.")
			u.line("    Run this again with sudo in front:  %s", u.cyan("sudo clare browser"))
			u.blank()
			return 1
		}
		if _, err := a.writeExtension(); err != nil {
			u.fail("clare couldn't write the browser extension's folder.")
			u.line("    %s", err)
			u.blank()
			return 1
		}
	}
	if len(a.detectBrowsers()) == 0 {
		u.warn("No Chromium browser found here (Chrome, Edge, Brave, Arc, Vivaldi, Opera or Chromium).")
		u.line("    clare's extension only runs in those. Claude Code on this computer is still covered.")
		u.blank()
		return 0
	}
	// A one-hour code that can only add a browser; the browser gets this computer's admin rights.
	var resp struct {
		Code string `json:"code"`
	}
	err = a.client(cfg.API, cfg.Token).call(10*time.Second, "POST", "/enroll-code", map[string]any{"kind": "extension", "admin": true}, &resp)
	if err != nil || resp.Code == "" {
		switch {
		case isOffline(err):
			u.fail("clare can't reach its server right now. Check your internet connection and try again.")
		case isRevoked(err):
			u.fail("This computer was removed from clare. Add it again from your dashboard.")
		default:
			u.fail(fmt.Sprintf("clare couldn't start adding a browser: %v", err))
		}
		u.blank()
		return 1
	}
	a.runBrowserGuide(u, cfg, resp.Code)
	u.blank()
	return 0
}

func joinAnd(items []string) string {
	switch len(items) {
	case 0:
		return ""
	case 1:
		return items[0]
	case 2:
		return items[0] + " and " + items[1]
	}
	return strings.Join(items[:len(items)-1], ", ") + " and " + items[len(items)-1]
}
