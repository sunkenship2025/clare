package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// The watchdog runs `clare watchdog` as root every 5 minutes: heartbeat,
// tamper check + repair, settings sync, self-uninstall when revoked.

const (
	launchdLabel   = "com.clare.watchdog"
	launchdPlist   = "/Library/LaunchDaemons/com.clare.watchdog.plist"
	systemdService = "/etc/systemd/system/clare-watchdog.service"
	systemdTimer   = "/etc/systemd/system/clare-watchdog.timer"
	cronFile       = "/etc/cron.d/clare"
	windowsTask    = "clare watchdog"
)

func (a *App) installService() error {
	bin := a.binPath()
	switch a.GOOS {
	case "darwin":
		plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>%s</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string>
    <string>watchdog</string>
  </array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
`, launchdLabel, xmlEscape(bin))
		if err := writeFileAtomic(launchdPlist, []byte(plist), 0o644); err != nil {
			return err
		}
		_ = exec.Command("launchctl", "bootout", "system/"+launchdLabel).Run()
		if err := exec.Command("launchctl", "bootstrap", "system", launchdPlist).Run(); err != nil {
			// Older macOS
			return exec.Command("launchctl", "load", "-w", launchdPlist).Run()
		}
		return nil

	case "linux":
		if _, err := exec.LookPath("systemctl"); err == nil && fileExists("/run/systemd/system") {
			service := fmt.Sprintf("[Unit]\nDescription=clare watchdog\n\n[Service]\nType=oneshot\nExecStart=%q watchdog\n", bin)
			timer := "[Unit]\nDescription=Run the clare watchdog every 5 minutes\n\n[Timer]\nOnBootSec=1min\nOnUnitActiveSec=5min\n\n[Install]\nWantedBy=timers.target\n"
			if err := writeFileAtomic(systemdService, []byte(service), 0o644); err != nil {
				return err
			}
			if err := writeFileAtomic(systemdTimer, []byte(timer), 0o644); err != nil {
				return err
			}
			_ = exec.Command("systemctl", "daemon-reload").Run()
			return exec.Command("systemctl", "enable", "--now", "clare-watchdog.timer").Run()
		}
		// No systemd (containers, some distros): cron.
		line := fmt.Sprintf("*/5 * * * * root %q watchdog >/dev/null 2>&1\n", bin)
		return writeFileAtomic(cronFile, []byte(line), 0o644)

	case "windows":
		return exec.Command("schtasks", "/Create", "/TN", windowsTask,
			"/TR", fmt.Sprintf(`"%s" watchdog`, bin),
			"/SC", "MINUTE", "/MO", "5", "/RU", "SYSTEM", "/RL", "HIGHEST", "/F").Run()
	}
	return nil
}

func (a *App) removeService() {
	switch a.GOOS {
	case "darwin":
		_ = exec.Command("launchctl", "bootout", "system/"+launchdLabel).Run()
		_ = os.Remove(launchdPlist)
	case "linux":
		if fileExists(systemdTimer) {
			_ = exec.Command("systemctl", "disable", "--now", "clare-watchdog.timer").Run()
			_ = os.Remove(systemdTimer)
			_ = os.Remove(systemdService)
			_ = exec.Command("systemctl", "daemon-reload").Run()
		}
		_ = os.Remove(cronFile)
	case "windows":
		_ = exec.Command("schtasks", "/Delete", "/TN", windowsTask, "/F").Run()
	}
}

func (a *App) serviceInstalled() bool {
	switch a.GOOS {
	case "darwin":
		return fileExists(launchdPlist)
	case "linux":
		return fileExists(systemdTimer) || fileExists(cronFile)
	case "windows":
		return exec.Command("schtasks", "/Query", "/TN", windowsTask).Run() == nil
	}
	return true
}

// installSymlink makes `clare` work in any terminal on macOS/Linux.
func (a *App) installSymlink() {
	if a.GOOS == "windows" {
		return
	}
	_ = os.MkdirAll(filepath.Dir(symlinkPath), 0o755)
	if fi, err := os.Lstat(symlinkPath); err == nil {
		if fi.Mode()&os.ModeSymlink == 0 {
			return // a real file we didn't create: leave it alone
		}
		_ = os.Remove(symlinkPath)
	}
	_ = os.Symlink(a.binPath(), symlinkPath)
}

func (a *App) removeSymlink() {
	if a.GOOS == "windows" {
		return
	}
	if target, err := os.Readlink(symlinkPath); err == nil && target == a.binPath() {
		_ = os.Remove(symlinkPath)
	}
}

func xmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}
