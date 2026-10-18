package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Self-update (docs/ARCHITECTURE.md → Updates). The watchdog checks the latest release every
// updateEvery. Its update.json lists each binary's SHA-256 and is signed with the release key
// (ed25519: the private half is a GitHub Actions secret, the public half is built into clare).
// A newer, correctly signed version that runs replaces the program and its backup copy, then
// finishes the watchdog run itself. Builds without a key or a releases address never update.

// Set at build time from clare.config.json (releasesUrl, updateKey).
var (
	defaultReleases = ""
	updatePublicKey = "" // base64 of the 32-byte ed25519 public key
)

const (
	updateEvery    = 6 * time.Hour
	maxManifest    = 64 << 10
	maxBinary      = 200 << 20
	updateDeadline = 5 * time.Minute
)

var errUpToDate = errors.New("up to date")

type updateManifest struct {
	Version string            `json:"version"`
	Files   map[string]string `json:"files"` // binary name → hex SHA-256
}

// updateState is root-owned bookkeeping next to the config.
type updateState struct {
	CheckedAt time.Time `json:"checked_at"`
	Problem   string    `json:"problem,omitempty"` // why the last attempt failed, for clare doctor
}

func (a *App) updateStatePath() string { return filepath.Join(a.clareDir(), "update.json") }

func (a *App) loadUpdateState() updateState {
	var st updateState
	_ = readJSONFile(a.updateStatePath(), &st)
	return st
}

// updatesOn: this build knows where releases are and which key signs them.
func updatesOn() bool {
	_, ok := releaseKey()
	return ok && defaultReleases != "" && version != "dev"
}

func releaseKey() (ed25519.PublicKey, bool) {
	k, err := base64.StdEncoding.DecodeString(strings.TrimSpace(updatePublicKey))
	if err != nil || len(k) != ed25519.PublicKeySize {
		return nil, false
	}
	return ed25519.PublicKey(k), true
}

// maybeUpdate checks for a newer release at most every updateEvery and installs it.
// It reports whether a new version is now in place.
func (a *App) maybeUpdate() bool {
	if a.GOOS == "windows" {
		_ = os.Remove(a.binPath() + ".old") // the version replaced last time, once it has exited
	}
	if !updatesOn() {
		return false
	}
	st := a.loadUpdateState()
	if a.Now().Sub(st.CheckedAt) < updateEvery {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), updateDeadline)
	defer cancel()
	err := a.update(ctx)
	st = updateState{CheckedAt: a.Now()}
	if err != nil && !errors.Is(err, errUpToDate) {
		st.Problem = err.Error()
	}
	_ = writeJSONAtomic(a.updateStatePath(), st, 0o644)
	return err == nil
}

func (a *App) update(ctx context.Context) error {
	key, _ := releaseKey()
	base := strings.TrimRight(defaultReleases, "/")
	body, err := a.fetch(ctx, base+"/update.json", maxManifest, nil)
	if err != nil {
		return err
	}
	sig, err := a.fetch(ctx, base+"/update.json.sig", 1<<10, nil)
	if err != nil {
		return err
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sig)))
	if err != nil || !ed25519.Verify(key, body, raw) {
		return errors.New("the update's signature didn't match, so it wasn't installed")
	}
	var m updateManifest
	if json.Unmarshal(body, &m) != nil {
		return errors.New("the update's file list couldn't be read")
	}
	if !newerVersion(m.Version, version) {
		return errUpToDate
	}
	name := "clare-" + a.GOOS + "-" + runtime.GOARCH
	if a.GOOS == "windows" {
		name += ".exe"
	}
	want, ok := m.Files[name]
	if !ok {
		return fmt.Errorf("clare %s has no download for this computer (%s)", m.Version, name)
	}

	next := filepath.Join(a.clareDir(), "clare.next")
	if a.GOOS == "windows" {
		next += ".exe"
	}
	defer os.Remove(next)
	f, err := os.OpenFile(next, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	sum := sha256.New()
	_, err = a.fetch(ctx, base+"/"+name, maxBinary, io.MultiWriter(f, sum))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if hex.EncodeToString(sum.Sum(nil)) != strings.ToLower(want) {
		return fmt.Errorf("the download of clare %s was damaged, so it wasn't installed", m.Version)
	}
	// It has to run here and be the version it claims (wrong architecture, a stub, …).
	run, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(run, next, "version").Output()
	if err != nil || strings.TrimSpace(string(out)) != "clare "+m.Version {
		return fmt.Errorf("clare %s didn't start on this computer, so it wasn't installed", m.Version)
	}
	if err := a.swapBinary(next); err != nil {
		return err
	}
	// The tamper check compares the program with its backup copy: refresh both.
	return a.writeBackup()
}

// swapBinary puts next in place of the running program. Unix replaces the file; Windows can't
// overwrite a running .exe but can rename it, so the old one moves aside until it exits.
func (a *App) swapBinary(next string) error {
	bin := a.binPath()
	if a.GOOS != "windows" {
		return os.Rename(next, bin)
	}
	old := bin + ".old"
	_ = os.Remove(old)
	if err := os.Rename(bin, old); err != nil {
		return err
	}
	if err := os.Rename(next, bin); err != nil {
		_ = os.Rename(old, bin)
		return err
	}
	return nil
}

// fetch downloads url into w (or returns the body when w is nil), refusing more than limit bytes.
func (a *App) fetch(ctx context.Context, url string, limit int64, w io.Writer) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "clare/"+version)
	resp, err := a.HTTP.Do(req)
	if err != nil {
		return nil, errors.New("couldn't reach the download server")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("the download server said %d for %s", resp.StatusCode, filepath.Base(url))
	}
	var buf bytes.Buffer
	if w == nil {
		w = &buf
	}
	n, err := io.Copy(w, io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, errors.New("the download was interrupted")
	}
	if n > limit {
		return nil, fmt.Errorf("%s is larger than expected", filepath.Base(url))
	}
	return buf.Bytes(), nil
}

// newerVersion: is a (like "0.2.7") a later release than b? Anything unparsable is not.
func newerVersion(a, b string) bool {
	pa, okA := parseVersion(a)
	pb, okB := parseVersion(b)
	if !okA || !okB {
		return false
	}
	for i := range pa {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return false
}

func parseVersion(v string) ([3]int, bool) {
	var out [3]int
	parts := strings.Split(strings.TrimPrefix(strings.TrimSpace(v), "v"), ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}
