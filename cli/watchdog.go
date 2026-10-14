package main

import (
	"os"
	"path/filepath"
	"time"
)

// runWatchdog is run by the OS every 5 minutes as root. It is silent and
// always exits 0; problems are reported to the server, not printed.
func (a *App) runWatchdog() int {
	cfg, err := a.loadConfig()
	if err != nil {
		// Config deleted or damaged: restore it from the root-only backup.
		backup := filepath.Join(a.backupDir(), "config.json")
		if !fileExists(backup) || copyFile(backup, a.configPath(), 0o644) != nil {
			return 0
		}
		if cfg, err = a.loadConfig(); err != nil {
			return 0
		}
	}

	problems := a.checkIntegrity(cfg, true)

	var resp heartbeatResponse
	err = a.client(cfg.API, cfg.Token).call(15*time.Second, "POST", "/heartbeat", heartbeatRequest{
		Info:   a.deviceInfo(cfg),
		Health: health{OK: len(problems) == 0, Problems: problems},
	}, &resp)
	if isRevoked(err) {
		a.removeEverything()
		return 0
	}
	if err != nil {
		return 0
	}

	// Strict hooks can be switched on and off from the dashboard.
	if s := resp.Settings.StrictHooks; s != nil && *s != cfg.StrictHooks {
		cfg.StrictHooks = *s
		if a.saveConfig(cfg) == nil && a.writeDropIn(cfg.StrictHooks) == nil {
			_ = a.writeBackup()
		}
	}
	if resp.Status != nil {
		_ = writeJSONAtomic(a.systemStatusPath(), statusCache{Status: resp.Status, FetchedAt: a.Now()}, 0o644)
	}
	return 0
}

// checkIntegrity compares the guarded files with the backup. With repair it puts
// them back. Problems are short lowercase phrases: the server puts them inside its
// alert sentence ("clare's files on MacBook Air were changed (…)").
func (a *App) checkIntegrity(cfg *Config, repair bool) []string {
	var problems []string
	backup := a.backupDir()

	var sums map[string]string
	_ = readJSONFile(filepath.Join(backup, "checksums.json"), &sums)
	if want := sums["binary"]; want != "" {
		if got, err := sha256File(a.binPath()); err != nil || got != want {
			problems = append(problems, "the clare program was changed or deleted")
			if repair {
				_ = copyFile(filepath.Join(backup, a.binName()), a.binPath(), 0o755)
			}
		}
	}

	if !a.dropInHealthy(cfg.StrictHooks) {
		problems = append(problems, "Claude Code hook settings were edited or removed")
		if repair {
			_ = a.writeDropIn(cfg.StrictHooks)
		}
	}

	if !a.NoService && !a.serviceInstalled() {
		problems = append(problems, "the background helper was removed")
		if repair {
			_ = a.installService()
		}
	}

	if a.GOOS == "darwin" && fileExists(mdmProfilePath) {
		problems = append(problems, "a device management profile on this Mac overrides clare's settings")
	}

	return problems
}

// removeEverything takes clare off this computer. Used by uninstall and when the
// server says this device was removed.
func (a *App) removeEverything() {
	if !a.NoService {
		a.removeService()
		a.removeSymlink()
	}
	_ = os.Remove(a.dropInPath())
	_ = os.Remove(a.dropInDir()) // only succeeds if empty
	if a.GOOS == "windows" {
		scheduleDelete(a.clareDir())
		return
	}
	_ = os.RemoveAll(a.clareDir())
}
