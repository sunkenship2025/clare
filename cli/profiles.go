package main

import (
	"os"
	"path/filepath"
	"strings"
)

// One computer can have several Claude Code profiles (e.g. clauth starts each with its own
// CLAUDE_CONFIG_DIR, often signed in to different Claude accounts). Managed settings reach
// all of them, so a computer can be limited to some profiles: elsewhere clare's hooks and
// status line stay out of the way (no reporting, no meter readings, no blocking).
//
// A profile is a name ("pranav" matches ~/.clauth/profiles/pranav/…, or a config dir whose
// own name is "pranav") or a path (that config dir or anything inside it). "default" is
// plain ~/.claude.

// currentConfigDir is the Claude Code config dir this hook or status line runs for.
func currentConfigDir() string {
	if dir := os.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
		return filepath.Clean(dir)
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude")
}

// profileMatches reports whether a config dir belongs to one profile entry.
func profileMatches(entry, dir string) bool {
	entry = strings.TrimSpace(entry)
	if entry == "" {
		return false
	}
	slashed := filepath.ToSlash(dir) + "/"
	if strings.ContainsAny(entry, `/\`) {
		if strings.HasPrefix(entry, "~/") {
			home, _ := os.UserHomeDir()
			entry = filepath.Join(home, entry[2:])
		}
		prefix := strings.TrimSuffix(filepath.ToSlash(filepath.Clean(entry)), "/") + "/"
		return strings.HasPrefix(slashed, prefix)
	}
	if entry == "default" {
		return os.Getenv("CLAUDE_CONFIG_DIR") == "" || filepath.Base(dir) == ".claude"
	}
	return strings.Contains(slashed, "/profiles/"+entry+"/") || filepath.Base(dir) == entry
}

// profileCovered: should clare act in this Claude Code session? Always, unless the
// computer was limited to certain profiles.
func (c *Config) profileCovered() bool {
	if c == nil || len(c.Profiles) == 0 {
		return true
	}
	dir := currentConfigDir()
	for _, p := range c.Profiles {
		if profileMatches(p, dir) {
			return true
		}
	}
	return false
}

// parseProfiles splits "pranav, work" and repeated flags into a clean list.
func parseProfiles(values []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, v := range values {
		for _, p := range strings.Split(v, ",") {
			if p = strings.TrimSpace(p); p != "" && !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
		}
	}
	return out
}

// runProfile is `clare profile`: show or change which Claude Code profiles clare covers.
//
//	clare profile              show
//	sudo clare profile pranav  only these profiles (comma-separated or several args)
//	sudo clare profile --all   every profile again
func (a *App) runProfile(args []string) int {
	u := newUI(a.Out)
	u.blank()
	cfg, err := a.loadConfig()
	if err != nil {
		u.fail("This computer isn't enrolled in clare yet.")
		u.blank()
		return 1
	}
	if len(args) == 0 {
		if len(cfg.Profiles) == 0 {
			u.line("  clare covers every Claude Code profile on this computer.")
		} else {
			u.line("  clare covers only these Claude Code profiles: %s", u.bold(strings.Join(cfg.Profiles, ", ")))
			u.line("  %s", u.dim("Other profiles aren't tracked or limited."))
		}
		u.line("  This session's profile folder: %s (%s)", currentConfigDir(), map[bool]string{true: "covered", false: "not covered"}[cfg.profileCovered()])
		u.blank()
		return 0
	}
	if !a.isRoot() {
		u.fail("Changing this needs administrator rights.")
		u.line("    Run it again with sudo in front:  sudo clare profile %s", strings.Join(args, " "))
		u.blank()
		return 1
	}
	if args[0] == "--all" || args[0] == "all" {
		cfg.Profiles = nil
	} else {
		cfg.Profiles = parseProfiles(args)
	}
	if err := a.saveConfig(cfg); err != nil || a.writeBackup() != nil {
		u.fail("clare couldn't save that. Try again, or run:  sudo clare doctor")
		u.blank()
		return 1
	}
	if len(cfg.Profiles) == 0 {
		u.ok("clare now covers every Claude Code profile on this computer.")
	} else {
		u.ok("clare now covers only: " + strings.Join(cfg.Profiles, ", ") + ". Other profiles aren't tracked or limited.")
	}
	u.blank()
	return 0
}
