package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// runQuiet runs a small system command and returns its stdout, or "" on any error.
func runQuiet(name string, args ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).Output()
	if err != nil {
		return ""
	}
	return string(out)
}

// machineID is a stable, hashed identifier for this computer, so re-running the
// installer replaces the old device instead of adding a duplicate.
func machineID(goos string) string {
	raw := ""
	switch goos {
	case "darwin":
		for _, line := range strings.Split(runQuiet("ioreg", "-rd1", "-c", "IOPlatformExpertDevice"), "\n") {
			if strings.Contains(line, "IOPlatformUUID") {
				if parts := strings.Split(line, "\""); len(parts) >= 4 {
					raw = parts[3]
				}
			}
		}
	case "linux":
		for _, p := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
			if b, err := os.ReadFile(p); err == nil && len(strings.TrimSpace(string(b))) > 0 {
				raw = strings.TrimSpace(string(b))
				break
			}
		}
	case "windows":
		out := runQuiet("reg", "query", `HKLM\SOFTWARE\Microsoft\Cryptography`, "/v", "MachineGuid")
		for _, line := range strings.Split(out, "\n") {
			if strings.Contains(line, "MachineGuid") {
				f := strings.Fields(line)
				raw = f[len(f)-1]
			}
		}
	}
	if raw == "" {
		raw, _ = os.Hostname()
	}
	sum := sha256.Sum256([]byte("clare-machine:" + raw))
	return hex.EncodeToString(sum[:16])
}

// computerName is the name you recognise this computer by, e.g. "Pranav's MacBook Air".
func computerName(goos string) string {
	if goos == "darwin" {
		if n := strings.TrimSpace(runQuiet("scutil", "--get", "ComputerName")); n != "" {
			return n
		}
	}
	if goos == "windows" {
		if n := os.Getenv("COMPUTERNAME"); n != "" {
			return n
		}
	}
	n, _ := os.Hostname()
	n = strings.TrimSuffix(n, ".local")
	if n == "" {
		n = "This computer"
	}
	return n
}

func osPretty(goos string) string {
	switch goos {
	case "darwin":
		if v := strings.TrimSpace(runQuiet("sw_vers", "-productVersion")); v != "" {
			return "macOS " + v
		}
		return "macOS"
	case "windows":
		return "Windows"
	case "linux":
		if f, err := os.Open("/etc/os-release"); err == nil {
			defer f.Close()
			s := bufio.NewScanner(f)
			for s.Scan() {
				if v, ok := strings.CutPrefix(s.Text(), "PRETTY_NAME="); ok {
					return strings.Trim(v, `"`)
				}
			}
		}
		return "Linux"
	}
	return goos
}

// invokingHome is the real user's home dir, even when running under sudo.
func invokingHome(goos string) string {
	if u := os.Getenv("SUDO_USER"); u != "" && u != "root" {
		switch goos {
		case "darwin":
			return "/Users/" + u
		case "linux":
			return "/home/" + u
		}
	}
	h, _ := os.UserHomeDir()
	return h
}

// claudeInstalled looks for Claude Code in the usual places (sudo resets PATH).
func claudeInstalled(goos string) bool {
	if _, err := exec.LookPath("claude"); err == nil {
		return true
	}
	home := invokingHome(goos)
	candidates := []string{
		filepath.Join(home, ".local", "bin", "claude"),
		filepath.Join(home, ".claude", "local", "claude"),
		"/opt/homebrew/bin/claude",
		"/usr/local/bin/claude",
		"/usr/bin/claude",
	}
	if goos == "windows" {
		candidates = []string{
			filepath.Join(home, ".local", "bin", "claude.exe"),
			filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "claude", "claude.exe"),
		}
	}
	for _, p := range candidates {
		if fileExists(p) {
			return true
		}
	}
	// Claude Code also keeps a config dir once it has ever run.
	return fileExists(filepath.Join(home, ".claude"))
}

func (a *App) deviceInfo(cfg *Config) map[string]any {
	host, _ := os.Hostname()
	info := map[string]any{
		"os":               osPretty(a.GOOS),
		"platform":         a.GOOS,
		"arch":             runtime.GOARCH,
		"hostname":         host,
		"version":          version,
		"claude_installed": claudeInstalled(a.GOOS),
	}
	if cfg != nil && cfg.MachineID != "" {
		info["machine_id"] = cfg.MachineID
	}
	return info
}

// isRoot: unix euid 0, or an elevated Windows session. Test mode skips the check.
func (a *App) isRoot() bool {
	if a.TestMode {
		return true
	}
	if a.GOOS == "windows" {
		return exec.Command("net", "session").Run() == nil
	}
	return os.Geteuid() == 0
}

// openBrowserAsUser opens a link in the signed-in user's browser. Under sudo the
// browser must not start as root, so it runs as the invoking user instead.
func (a *App) openBrowserAsUser(url string) bool {
	if a.TestMode {
		return false
	}
	if user := os.Getenv("SUDO_USER"); user != "" && user != "root" && a.GOOS != "windows" {
		opener := "xdg-open"
		if a.GOOS == "darwin" {
			opener = "open"
		}
		return exec.Command("sudo", "-u", user, opener, url).Start() == nil
	}
	return openBrowser(a.GOOS, url)
}
