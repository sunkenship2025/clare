package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func testExtension() fstest.MapFS {
	return fstest.MapFS{
		"manifest.json":  {Data: []byte(`{"manifest_version":3,"name":"clare","version":"0.2.0"}`)},
		"sw.js":          {Data: []byte("// service worker")},
		"popup/popup.js": {Data: []byte("// popup")},
		"README.md":      {Data: []byte("placeholder, never written")},
	}
}

func testBrowsers() []foundBrowser {
	var out []foundBrowser
	for _, k := range browserCatalog {
		switch k.ID {
		case "chrome":
			out = append(out, foundBrowser{browserKind: k, Path: "/Applications/Google Chrome.app"})
		case "brave":
			out = append(out, foundBrowser{browserKind: k, Path: "/Applications/Brave Browser.app"})
		}
	}
	return out
}

func fastExtensionPolling(t *testing.T) {
	wait, every := extensionWait, extensionPollEvery
	extensionWait, extensionPollEvery = 2*time.Second, 10*time.Millisecond
	t.Cleanup(func() { extensionWait, extensionPollEvery = wait, every })
}

func TestWriteExtensionInstallsAndRefreshes(t *testing.T) {
	ta := newTestApp(t)
	if changed, err := ta.writeExtension(); changed || err != nil {
		t.Fatalf("a build without the extension writes nothing: %v %v", changed, err)
	}
	ext := testExtension()
	ta.ExtFS = ext
	if err := os.MkdirAll(ta.clareDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	changed, err := ta.writeExtension()
	if !changed || err != nil {
		t.Fatalf("first write: %v %v", changed, err)
	}
	dir := ta.extensionDir()
	for _, p := range []string{"manifest.json", "sw.js", "popup/popup.js"} {
		if !fileExists(filepath.Join(dir, p)) {
			t.Fatalf("missing %s", p)
		}
	}
	if fileExists(filepath.Join(dir, "README.md")) {
		t.Fatal("the placeholder README must not be written")
	}
	if st, _ := os.Stat(filepath.Join(dir, "popup")); st.Mode().Perm() != 0o755 {
		t.Fatalf("folders must be readable by browsers: %v", st.Mode())
	}
	if changed, _ := ta.writeExtension(); changed {
		t.Fatal("the same version must not be rewritten")
	}

	ext["sw.js"] = &fstest.MapFile{Data: []byte("// v2")}
	if changed, _ := ta.writeExtension(); !changed {
		t.Fatal("a new version must replace the folder")
	}
	if data, _ := os.ReadFile(filepath.Join(dir, "sw.js")); string(data) != "// v2" {
		t.Fatalf("not refreshed: %q", data)
	}
	if fileExists(dir + ".new") {
		t.Fatal("temporary folder left behind")
	}
}

func TestBrowserCommandGuidesEachBrowser(t *testing.T) {
	fastExtensionPolling(t)
	api := newFakeAPI(t)
	api.set(func(f *fakeAPI) { f.extAfter = 2 }) // the browser appears on the first poll after loading
	ta := newTestApp(t)
	cfg := ta.install(t, api.srv.URL)
	cfg.Web = "https://me.github.io/clare"
	_ = ta.saveConfig(cfg)
	ta.ExtFS = testExtension()
	ta.Browsers = testBrowsers
	ta.TTY = strings.NewReader("\ns\n") // Chrome: loaded. Brave: skip.

	if code := ta.run([]string{"browser"}); code != 0 {
		t.Fatalf("clare browser failed: %s", ta.out.String())
	}
	out := ta.out.String()
	dir := ta.extensionDir()
	for _, want := range []string{
		"Found Google Chrome and Brave.",
		"Google Chrome (1 of 2)",
		"go to chrome://extensions",
		"the Developer mode switch at the top right",
		"Load unpacked",
		dir,
		"⌘⇧G",
		"Connecting clare in Google Chrome",
		"Google Chrome is connected.",
		"Brave (2 of 2)",
		"brave://extensions",
		"Skipped Brave.",
		"clare browser",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in:\n%s", want, out)
		}
	}
	if api.codeBody["kind"] != "extension" {
		t.Fatalf("clare browser must ask for a browser-only code: %v", api.codeBody)
	}
	opened := strings.Join(ta.opened, "\n")
	for _, want := range []string{
		"open -a /Applications/Google Chrome.app chrome://extensions",
		"open -R " + dir,
		"clipboard " + dir,
		"open -a /Applications/Google Chrome.app https://me.github.io/clare/enroll.html#brw123",
		"open -a /Applications/Brave Browser.app brave://extensions",
	} {
		if !strings.Contains(opened, want) {
			t.Fatalf("expected %q, got:\n%s", want, opened)
		}
	}
	if strings.Contains(opened, "Brave Browser.app https://") {
		t.Fatal("a skipped browser must not get the enroll page")
	}
	if strings.Count(opened, "open -R") != 1 {
		t.Fatal("the folder is revealed once, not per browser")
	}
}

func TestBrowserGuideFallsBackWhenTheBrowserNeverShowsUp(t *testing.T) {
	fastExtensionPolling(t)
	extensionWait = 50 * time.Millisecond
	api := newFakeAPI(t) // extAfter 0: never enrolls
	ta := newTestApp(t)
	cfg := ta.install(t, api.srv.URL)
	cfg.Web = "https://w"
	_ = ta.saveConfig(cfg)
	ta.ExtFS = testExtension()
	ta.Browsers = func() []foundBrowser { return testBrowsers()[:1] }
	ta.TTY = strings.NewReader("\n")

	ta.run([]string{"browser"})
	out := ta.out.String()
	if !strings.Contains(out, "clare hasn't heard from Google Chrome yet") || !strings.Contains(out, "brw123") {
		t.Fatalf("expected the paste-the-code fallback:\n%s", out)
	}
	if strings.Contains(out, "(1 of 1)") {
		t.Fatal("no counter for a single browser")
	}
}

func TestEnrollRunsTheBrowserGuideUnlessToldNotTo(t *testing.T) {
	api := newFakeAPI(t)
	ta := newTestApp(t)
	ta.ExtFS = testExtension()
	ta.Browsers = testBrowsers

	// No terminal to ask (TTY unset): every browser's steps at once.
	if code := ta.run([]string{"enroll", "k3F9", "--api", api.srv.URL, "--web", "https://w"}); code != 0 {
		t.Fatalf("enroll failed: %s", ta.out.String())
	}
	out := ta.out.String()
	if !ta.extensionReady() {
		t.Fatal("enroll must write the extension folder")
	}
	for _, want := range []string{"Now your browsers", "For each browser:", "Google Chrome", "brave://extensions", "https://w/enroll.html#k3F9"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in:\n%s", want, out)
		}
	}

	ta2 := newTestApp(t)
	ta2.ExtFS = testExtension()
	ta2.Browsers = testBrowsers
	ta2.run([]string{"enroll", "k3F9", "--api", api.srv.URL, "--web", "https://w", "--no-browser"})
	if strings.Contains(ta2.out.String(), "Now your browsers") {
		t.Fatal("--no-browser skips the guide")
	}
}

func TestBrowserCommandNeedsEnrollmentAndABrowser(t *testing.T) {
	ta := newTestApp(t)
	if code := ta.run([]string{"browser"}); code != 1 || !strings.Contains(ta.out.String(), "isn't enrolled") {
		t.Fatalf("got %d: %s", code, ta.out.String())
	}

	api := newFakeAPI(t)
	ta = newTestApp(t)
	ta.install(t, api.srv.URL)
	ta.Browsers = func() []foundBrowser { return nil }
	if code := ta.run([]string{"browser"}); code != 0 || !strings.Contains(ta.out.String(), "No Chromium browser found") {
		t.Fatalf("got %d: %s", code, ta.out.String())
	}
}

func TestBrowserCatalogCoversTheCommonBrowsers(t *testing.T) {
	ids := map[string]browserKind{}
	for _, k := range browserCatalog {
		ids[k.ID] = k
		if k.Page == "" || k.DevMode == "" || k.Name == "" {
			t.Fatalf("incomplete entry: %+v", k)
		}
	}
	for _, id := range []string{"chrome", "edge", "brave", "arc", "vivaldi", "opera"} {
		if _, ok := ids[id]; !ok {
			t.Fatalf("missing %s", id)
		}
	}
	if !strings.Contains(ids["edge"].DevMode, "left sidebar") {
		t.Fatal("Edge keeps Developer mode in the sidebar")
	}
	if joinAnd([]string{"A", "B", "C"}) != "A, B and C" {
		t.Fatal(joinAnd([]string{"A", "B", "C"}))
	}
}
