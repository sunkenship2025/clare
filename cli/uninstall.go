package main

import (
	"bufio"
	"os"
	"os/exec"
	"strings"
	"time"
)

func (a *App) runUninstall(args []string) int {
	u := newUI(a.Out)
	yes := false
	for _, arg := range args {
		if arg == "--yes" || arg == "-y" {
			yes = true
		}
	}

	u.blank()
	if !a.isRoot() {
		u.fail("Removing clare needs your computer's permission.")
		u.line("    Run it again with sudo in front:  sudo clare uninstall")
		u.blank()
		return 1
	}

	cfg, _ := a.loadConfig()
	if cfg == nil && !fileExists(a.dropInPath()) && !fileExists(a.clareDir()) {
		u.line("  clare isn't installed on this computer. Nothing to remove.")
		u.blank()
		return 0
	}

	if !yes {
		u.line("  This removes clare from this computer. Claude Code here will stop reporting usage")
		u.line("  and stop following your weekly budget; the dashboard will show it as removed.")
		u.blank()
		u.line("  Remove clare? Type y and press Enter:")
		answer, _ := bufio.NewReader(a.In).ReadString('\n')
		if ans := strings.ToLower(strings.TrimSpace(answer)); ans != "y" && ans != "yes" {
			u.blank()
			u.line("  OK, nothing was changed.")
			u.blank()
			return 0
		}
	}

	if cfg != nil {
		_ = a.client(cfg.API, cfg.Token).call(5*time.Second, "POST", "/device/remove", map[string]any{"reason": "uninstalled"}, nil)
	}
	a.removeEverything()

	if !yes {
		u.blank()
	}
	u.ok("clare was removed from this computer.")
	u.blank()
	return 0
}

// scheduleDelete removes a folder shortly after we exit. Windows can't delete a
// running .exe, so a detached cmd waits a moment and then cleans up.
func scheduleDelete(dir string) {
	cmd := exec.Command("cmd", "/C", "ping 127.0.0.1 -n 3 > nul & rmdir /s /q \""+dir+"\"")
	_ = cmd.Start()
	_ = os.RemoveAll(dir) // removes everything except the running exe
}
