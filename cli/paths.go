package main

import (
	"os"
	"path/filepath"
)

// defaultSystemDir is where Claude Code looks for managed settings on each OS.
func defaultSystemDir(goos string) string {
	switch goos {
	case "darwin":
		return "/Library/Application Support/ClaudeCode"
	case "windows":
		return `C:\Program Files\ClaudeCode`
	default:
		return "/etc/claude-code"
	}
}

// defaultStateDir is the per-user cache dir. Hooks run as the user, so this
// must be writable without root.
func defaultStateDir(goos string) string {
	home, _ := os.UserHomeDir()
	return stateDirIn(goos, home)
}

func stateDirIn(goos, home string) string {
	switch goos {
	case "darwin":
		return filepath.Join(home, "Library", "Caches", "clare")
	case "windows":
		if d := os.Getenv("LOCALAPPDATA"); d != "" {
			return filepath.Join(d, "clare")
		}
		return filepath.Join(home, "AppData", "Local", "clare")
	default:
		if d := os.Getenv("XDG_CACHE_HOME"); d != "" {
			return filepath.Join(d, "clare")
		}
		return filepath.Join(home, ".cache", "clare")
	}
}

func (a *App) clareDir() string   { return filepath.Join(a.SysDir, "clare") }
func (a *App) configPath() string { return filepath.Join(a.clareDir(), "config.json") }
func (a *App) backupDir() string  { return filepath.Join(a.clareDir(), ".backup") }
func (a *App) dropInDir() string  { return filepath.Join(a.SysDir, "managed-settings.d") }
func (a *App) dropInPath() string { return filepath.Join(a.dropInDir(), "50-clare.json") }

// systemStatusPath is a status cache written by the (root) watchdog and enroll,
// readable by every user's hooks as a fallback.
func (a *App) systemStatusPath() string { return filepath.Join(a.clareDir(), "status.json") }

func (a *App) binName() string {
	if a.GOOS == "windows" {
		return "clare.exe"
	}
	return "clare"
}

func (a *App) binPath() string { return filepath.Join(a.clareDir(), a.binName()) }

func (a *App) statePath(name string) string { return filepath.Join(a.StateDir, name) }

// symlinkPath puts `clare` on PATH for unix users.
const symlinkPath = "/usr/local/bin/clare"

const mdmProfilePath = "/Library/Managed Preferences/com.anthropic.claudecode.plist"
