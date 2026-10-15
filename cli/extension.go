package main

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

// The browser extension rides inside the binary (scripts/build.mjs copies the built
// extension into ext/ first) and is written to <sys>/clare/extension, a stable folder
// each browser loads with "Load unpacked". Unpacked extensions are read from disk when
// the browser starts, so when the watchdog refreshes the folder after an upgrade, every
// browser picks up the new version on its next restart.
//
//go:embed all:ext
var embeddedExt embed.FS

func (a *App) extensionDir() string { return filepath.Join(a.clareDir(), "extension") }
func (a *App) extensionSum() string { return filepath.Join(a.clareDir(), "extension.sum") }

// extFS is the bundled extension, or nil when this build doesn't carry one (dev builds).
func (a *App) extFS() fs.FS {
	fsys := a.ExtFS
	if fsys == nil {
		sub, err := fs.Sub(embeddedExt, "ext")
		if err != nil {
			return nil
		}
		fsys = sub
	}
	if _, err := fs.Stat(fsys, "manifest.json"); err != nil {
		return nil
	}
	return fsys
}

// extensionReady: the folder is on disk and can be loaded.
func (a *App) extensionReady() bool {
	return fileExists(filepath.Join(a.extensionDir(), "manifest.json"))
}

func extFiles(fsys fs.FS) ([]string, error) {
	var files []string
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && p != "README.md" {
			files = append(files, p)
		}
		return nil
	})
	sort.Strings(files)
	return files, err
}

func extChecksum(fsys fs.FS, files []string) (string, error) {
	h := sha256.New()
	for _, p := range files {
		data, err := fs.ReadFile(fsys, p)
		if err != nil {
			return "", err
		}
		h.Write([]byte(p + "\x00"))
		h.Write(data)
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// writeExtension puts the bundled extension in its folder (root-owned, world-readable)
// unless the same version is already there. It reports whether anything changed.
func (a *App) writeExtension() (bool, error) {
	fsys := a.extFS()
	if fsys == nil {
		return false, nil
	}
	files, err := extFiles(fsys)
	if err != nil {
		return false, err
	}
	sum, err := extChecksum(fsys, files)
	if err != nil {
		return false, err
	}
	if old, _ := os.ReadFile(a.extensionSum()); string(old) == sum && a.extensionReady() {
		return false, nil
	}

	// Build next to the final folder, then swap, so a browser never sees half a version.
	dir := a.extensionDir()
	tmp := dir + ".new"
	_ = os.RemoveAll(tmp)
	for _, p := range files {
		data, err := fs.ReadFile(fsys, p)
		if err != nil {
			return false, err
		}
		dst := filepath.Join(tmp, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return false, err
		}
		if err := os.WriteFile(dst, data, 0o644); err != nil {
			return false, err
		}
	}
	_ = os.RemoveAll(dir)
	if err := os.Rename(tmp, dir); err != nil {
		return false, err
	}
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && d.IsDir() {
			_ = os.Chmod(p, 0o755)
		}
		return nil
	})
	return true, writeFileAtomic(a.extensionSum(), []byte(sum), 0o644)
}
