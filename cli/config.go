package main

import (
	"errors"
	"io/fs"
	"time"
)

// Config is this computer's clare enrollment, stored root-owned but world-readable
// (hooks run as the user and need the token).
type Config struct {
	API         string `json:"api"`
	Web         string `json:"web,omitempty"`
	Token       string `json:"token"`
	DeviceID    string `json:"device_id"`
	Label       string `json:"label"`
	MachineID   string `json:"machine_id"`
	StrictHooks bool   `json:"strict_hooks"`
	EnrolledAt  string `json:"enrolled_at"`
	Version     string `json:"version,omitempty"`
	// Claude Code profiles clare covers on this computer (empty = all). See profiles.go.
	Profiles []string `json:"profiles,omitempty"`
}

var (
	errNotInstalled  = errors.New("clare is not set up on this computer")
	errConfigCorrupt = errors.New("clare's settings file is damaged")
)

func (a *App) loadConfig() (*Config, error) {
	var c Config
	err := readJSONFile(a.configPath(), &c)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, errNotInstalled
	}
	if err != nil || c.API == "" || c.Token == "" {
		return nil, errConfigCorrupt
	}
	return &c, nil
}

func (a *App) saveConfig(c *Config) error {
	return writeJSONAtomic(a.configPath(), c, 0o644)
}

// enrolledAt is when this computer was enrolled; usage before it is not counted.
func (c *Config) enrolledAt() time.Time {
	t, err := time.Parse(time.RFC3339, c.EnrolledAt)
	if err != nil {
		return time.Time{}
	}
	return t
}
