package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// fakeRelease serves update.json, its signature and one binary, like a GitHub release.
type fakeRelease struct {
	srv   *httptest.Server
	key   ed25519.PrivateKey
	files map[string][]byte
	hits  int
}

func newFakeRelease(t *testing.T, goos string) *fakeRelease {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	r := &fakeRelease{key: priv, files: map[string][]byte{}}
	r.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.hits++
		data, ok := r.files[strings.TrimPrefix(req.URL.Path, "/")]
		if !ok {
			w.WriteHeader(404)
			return
		}
		w.Write(data)
	}))
	t.Cleanup(r.srv.Close)

	oldV, oldR, oldK := version, defaultReleases, updatePublicKey
	version, defaultReleases, updatePublicKey = "0.2.7", r.srv.URL, base64.StdEncoding.EncodeToString(pub)
	t.Cleanup(func() { version, defaultReleases, updatePublicKey = oldV, oldR, oldK })
	return r
}

func binaryName(goos string) string {
	name := "clare-" + goos + "-" + runtime.GOARCH
	if goos == "windows" {
		name += ".exe"
	}
	return name
}

// publish puts a release of version v whose program prints `prints` for `clare version`.
func (r *fakeRelease) publish(goos, v, prints string) {
	bin := []byte("#!/bin/sh\necho '" + prints + "'\n")
	sum := sha256.Sum256(bin)
	name := binaryName(goos)
	manifest, _ := json.Marshal(updateManifest{Version: v, Files: map[string]string{name: hex.EncodeToString(sum[:])}})
	r.files = map[string][]byte{
		"update.json":     manifest,
		"update.json.sig": []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(r.key, manifest))),
		name:              bin,
	}
}

func installedBinary(t *testing.T, ta *testApp) string {
	t.Helper()
	data, err := os.ReadFile(ta.binPath())
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestUpdatesInstallANewerSignedRelease(t *testing.T) {
	for _, goos := range []string{"darwin", "windows"} {
		t.Run(goos, func(t *testing.T) {
			if runtime.GOOS == "windows" {
				t.Skip("the fake programs are shell scripts")
			}
			ta := newTestApp(t)
			ta.GOOS = goos
			ta.install(t, newFakeAPI(t).srv.URL)
			if err := ta.writeBackup(); err != nil {
				t.Fatal(err)
			}
			rel := newFakeRelease(t, goos)

			// Same version: nothing to do, and no new check for 6 hours.
			rel.publish(goos, "0.2.7", "clare 0.2.7")
			if ta.maybeUpdate() {
				t.Fatal("installed the version it already runs")
			}
			hits := rel.hits
			ta.clock = ta.clock.Add(time.Hour)
			rel.publish(goos, "0.2.8", "clare 0.2.8")
			if ta.maybeUpdate() || rel.hits != hits {
				t.Fatal("checked again within 6 hours")
			}

			// Six hours on, the newer release goes in, with its backup copy so the tamper check keeps it.
			ta.clock = ta.clock.Add(6 * time.Hour)
			if !ta.maybeUpdate() {
				t.Fatalf("didn't update: %+v", ta.loadUpdateState())
			}
			if got := installedBinary(t, ta); !strings.Contains(got, "clare 0.2.8") {
				t.Fatalf("installed program: %q", got)
			}
			if problems := ta.checkIntegrity(ta.mustConfig(t), false); len(problems) > 0 {
				t.Fatalf("the tamper check objects to the update: %v", problems)
			}
			if goos == "windows" {
				if !fileExists(ta.binPath() + ".old") {
					t.Fatal("the running program should be moved aside on Windows")
				}
				ta.clock = ta.clock.Add(time.Minute)
				ta.maybeUpdate()
				if fileExists(ta.binPath() + ".old") {
					t.Fatal("the old program is cleaned up on the next run")
				}
			}
			if fileExists(filepath.Join(ta.clareDir(), "clare.next")) || fileExists(filepath.Join(ta.clareDir(), "clare.next.exe")) {
				t.Fatal("download left behind")
			}
		})
	}
}

func TestUpdatesRefuseAnythingNotRight(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake programs are shell scripts")
	}
	ta := newTestApp(t)
	ta.install(t, newFakeAPI(t).srv.URL)
	if err := ta.writeBackup(); err != nil {
		t.Fatal(err)
	}
	rel := newFakeRelease(t, "darwin")
	before := installedBinary(t, ta)
	attempt := func(why string, want string) {
		t.Helper()
		ta.clock = ta.clock.Add(7 * time.Hour)
		if ta.maybeUpdate() {
			t.Fatalf("%s: installed it", why)
		}
		if installedBinary(t, ta) != before {
			t.Fatalf("%s: the program changed", why)
		}
		if got := ta.loadUpdateState().Problem; !strings.Contains(got, want) {
			t.Fatalf("%s: problem %q, want %q", why, got, want)
		}
	}
	name := binaryName("darwin")

	rel.publish("darwin", "0.2.8", "clare 0.2.8")
	rel.files["update.json.sig"] = []byte(base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize)))
	attempt("bad signature", "signature didn't match")

	rel.publish("darwin", "0.2.8", "clare 0.2.8")
	other, _ := json.Marshal(updateManifest{Version: "0.2.9", Files: map[string]string{name: "00"}})
	rel.files["update.json"] = other // signed list swapped for another
	attempt("tampered list", "signature didn't match")

	rel.publish("darwin", "0.2.8", "clare 0.2.8")
	rel.files[name] = []byte("#!/bin/sh\necho 'something else'\n")
	attempt("damaged download", "was damaged")

	rel.publish("darwin", "0.2.8", "clare 0.2.6")
	attempt("doesn't run as the version it claims", "didn't start")

	rel.publish("darwin", "0.2.6", "clare 0.2.6")
	attempt("older release", "")

	rel.publish("linux", "0.2.8", "clare 0.2.8") // a release with only other computers' downloads
	attempt("no download for this computer", "has no download for this computer")
}

func TestNewerVersion(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{
		{"0.2.7", "0.2.6", true}, {"0.10.0", "0.9.9", true}, {"v1.0.0", "0.9.0", true},
		{"0.2.6", "0.2.6", false}, {"0.2.5", "0.2.6", false}, {"0.2.7", "dev", false}, {"junk", "0.1.0", false},
	} {
		if got := newerVersion(c.a, c.b); got != c.want {
			t.Errorf("newerVersion(%q, %q) = %v", c.a, c.b, got)
		}
	}
}

func (ta *testApp) mustConfig(t *testing.T) *Config {
	t.Helper()
	cfg, err := ta.loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}
