package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Chromium browsers clare's extension runs in, with where each keeps its extensions
// page and Developer mode switch, so the browser guide can give exact steps.
type browserKind struct {
	ID       string
	Name     string
	Page     string   // the extensions page
	DevMode  string   // where the Developer mode switch is
	macApp   string   // app bundle name
	winExe   []string // relative to Program Files, Program Files (x86) or LocalAppData
	linuxBin []string
}

const topRightSwitch = "the Developer mode switch at the top right"

var browserCatalog = []browserKind{
	{ID: "chrome", Name: "Google Chrome", Page: "chrome://extensions", DevMode: topRightSwitch,
		macApp: "Google Chrome", winExe: []string{`Google\Chrome\Application\chrome.exe`},
		linuxBin: []string{"google-chrome", "google-chrome-stable"}},
	{ID: "edge", Name: "Microsoft Edge", Page: "edge://extensions",
		DevMode: "the Developer mode switch in the left sidebar (in a narrow window, open the ☰ menu first)",
		macApp:  "Microsoft Edge", winExe: []string{`Microsoft\Edge\Application\msedge.exe`},
		linuxBin: []string{"microsoft-edge", "microsoft-edge-stable"}},
	{ID: "brave", Name: "Brave", Page: "brave://extensions", DevMode: topRightSwitch,
		macApp: "Brave Browser", winExe: []string{`BraveSoftware\Brave-Browser\Application\brave.exe`},
		linuxBin: []string{"brave-browser", "brave"}},
	{ID: "arc", Name: "Arc", Page: "chrome://extensions", DevMode: topRightSwitch, macApp: "Arc"},
	{ID: "vivaldi", Name: "Vivaldi", Page: "vivaldi://extensions", DevMode: "the Developer Mode switch at the top right",
		macApp: "Vivaldi", winExe: []string{`Vivaldi\Application\vivaldi.exe`},
		linuxBin: []string{"vivaldi", "vivaldi-stable"}},
	{ID: "opera", Name: "Opera", Page: "opera://extensions", DevMode: topRightSwitch,
		macApp: "Opera", winExe: []string{`Programs\Opera\opera.exe`}, linuxBin: []string{"opera"}},
	{ID: "chromium", Name: "Chromium", Page: "chrome://extensions", DevMode: topRightSwitch,
		macApp: "Chromium", linuxBin: []string{"chromium", "chromium-browser"}},
}

// foundBrowser is an installed browser: its kind and the app bundle or executable.
type foundBrowser struct {
	browserKind
	Path string
}

// detectBrowsers lists the Chromium browsers installed on this computer, in catalog order.
func (a *App) detectBrowsers() []foundBrowser {
	if a.Browsers != nil {
		return a.Browsers()
	}
	var found []foundBrowser
	for _, k := range browserCatalog {
		if p := locateBrowser(a.GOOS, k); p != "" {
			found = append(found, foundBrowser{browserKind: k, Path: p})
		}
	}
	return found
}

func locateBrowser(goos string, k browserKind) string {
	switch goos {
	case "darwin":
		if k.macApp == "" {
			return ""
		}
		for _, dir := range []string{"/Applications", filepath.Join(invokingHome(goos), "Applications")} {
			if p := filepath.Join(dir, k.macApp+".app"); fileExists(p) {
				return p
			}
		}
	case "windows":
		for _, base := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA")} {
			for _, exe := range k.winExe {
				if base == "" {
					continue
				}
				if p := filepath.Join(base, exe); fileExists(p) {
					return p
				}
			}
		}
	default:
		for _, bin := range k.linuxBin {
			if p, err := exec.LookPath(bin); err == nil {
				return p
			}
		}
	}
	return ""
}

// sudoUser is the person who ran sudo, so browsers and Finder open as them, not root.
func sudoUser() string {
	if u := os.Getenv("SUDO_USER"); u != "" && u != "root" {
		return u
	}
	return ""
}

// startAsUser starts a GUI program as the signed-in user and doesn't wait for it.
func (a *App) startAsUser(name string, args ...string) bool {
	if a.TestMode {
		a.opened = append(a.opened, strings.TrimSpace(name+" "+strings.Join(args, " ")))
		return true
	}
	if u := sudoUser(); u != "" && a.GOOS != "windows" {
		return exec.Command("sudo", append([]string{"-u", u, name}, args...)...).Start() == nil
	}
	if a.GOOS == "windows" && a.isRoot() {
		return false // never start a browser elevated; the steps say where to go instead
	}
	return exec.Command(name, args...).Start() == nil
}

// openIn opens a URL (an https page or the browser's own extensions page) in one browser.
func (a *App) openIn(b foundBrowser, url string) bool {
	if a.GOOS == "darwin" {
		return a.startAsUser("open", "-a", b.Path, url)
	}
	return a.startAsUser(b.Path, url)
}

// revealFolder shows the extension folder in Finder, Explorer, or the Linux file browser.
func (a *App) revealFolder(dir string) bool {
	switch a.GOOS {
	case "darwin":
		return a.startAsUser("open", "-R", dir)
	case "windows":
		return a.startAsUser("explorer", "/select,"+dir)
	default:
		return a.startAsUser("xdg-open", filepath.Dir(dir))
	}
}

// copyText puts text on the signed-in user's clipboard, best effort.
func (a *App) copyText(text string) bool {
	if a.TestMode {
		a.opened = append(a.opened, "clipboard "+text)
		return true
	}
	var name string
	var args []string
	switch a.GOOS {
	case "darwin":
		name = "pbcopy"
	case "windows":
		name = "clip"
	default:
		if _, err := exec.LookPath("wl-copy"); err == nil {
			name = "wl-copy"
		} else if _, err := exec.LookPath("xclip"); err == nil {
			name, args = "xclip", []string{"-selection", "clipboard"}
		} else {
			return false
		}
	}
	if u := sudoUser(); u != "" && a.GOOS != "windows" {
		args = append([]string{"-u", u, name}, args...)
		name = "sudo"
	}
	cmd := exec.Command(name, args...)
	cmd.Stdin = strings.NewReader(text)
	return cmd.Run() == nil
}
