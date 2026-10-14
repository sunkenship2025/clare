package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeAPI is a tiny stand-in for the clare server.
type fakeAPI struct {
	mu           sync.Mutex
	srv          *httptest.Server
	status       Status
	revoked      bool
	unauthorized bool
	hits         map[string]int
	events       []Event
	meters       []Reading
	lastTZ       string
	enrollBody   enrollRequest
}

func newFakeAPI(t *testing.T) *fakeAPI {
	f := &fakeAPI{hits: map[string]int{}, status: okStatus(10)}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeAPI) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.hits[r.URL.Path]++
	f.lastTZ = r.Header.Get("X-Clare-TZ")
	w.Header().Set("Content-Type", "application/json")
	body, _ := io.ReadAll(r.Body)

	if r.URL.Path == "/enroll" {
		_ = json.Unmarshal(body, &f.enrollBody)
		switch f.enrollBody.Code {
		case "expired":
			w.WriteHeader(410)
			w.Write([]byte(`{"error":"expired_code","message":"This enroll link has expired."}`))
			return
		case "nope":
			w.WriteHeader(404)
			w.Write([]byte(`{"error":"invalid_code","message":"That code isn't valid."}`))
			return
		}
		st := f.status
		json.NewEncoder(w).Encode(enrollResponse{Token: "clr_test", DeviceID: "dev1", Status: &st})
		return
	}
	if f.unauthorized || r.Header.Get("Authorization") != "Bearer clr_test" {
		w.WriteHeader(401)
		w.Write([]byte(`{"error":"unauthorized","message":"This device isn't connected to clare."}`))
		return
	}
	if f.revoked {
		w.WriteHeader(410)
		w.Write([]byte(`{"error":"revoked","message":"This device was removed from clare."}`))
		return
	}
	switch r.URL.Path {
	case "/report":
		var req struct {
			Events []Event
			Meter  *Reading
		}
		_ = json.Unmarshal(body, &req)
		f.events = append(f.events, req.Events...)
		if req.Meter != nil {
			f.meters = append(f.meters, *req.Meter)
		}
		st := f.status
		json.NewEncoder(w).Encode(statusResponse{Accepted: len(req.Events), Status: &st})
	case "/check":
		st := f.status
		json.NewEncoder(w).Encode(statusResponse{Status: &st})
	case "/heartbeat":
		st := f.status
		json.NewEncoder(w).Encode(map[string]any{"status": st, "settings": map[string]any{"enforce": true, "strict_hooks": false}})
	case "/device/remove":
		w.Write([]byte(`{"ok":true}`))
	case "/login-link":
		w.Write([]byte(`{"code":"LOGIN123","expires_at":"2030-01-01T00:00:00Z"}`))
	default:
		w.WriteHeader(404)
		w.Write([]byte(`{"error":"not_found"}`))
	}
}

func (f *fakeAPI) hitCount(path string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hits[path]
}

func (f *fakeAPI) setStatus(s Status) {
	f.mu.Lock()
	f.status = s
	f.mu.Unlock()
}

func (f *fakeAPI) set(fn func(f *fakeAPI)) {
	f.mu.Lock()
	fn(f)
	f.mu.Unlock()
}

func okStatus(pct float64) Status {
	budget := 90.0
	used := pct / 100 * budget
	return Status{Allowed: true, State: "ok", Basis: "meter", Scope: "account", Used: used, Limit: budget, Pct: pct,
		Account:  AccountUse{Used: used, Budget: budget, Pct: pct},
		Device:   &DeviceUse{ID: "dev1", Label: "Test Mac", Used: used / 2},
		ResetsAt: time.Now().Add(72 * time.Hour).UTC().Format(time.RFC3339), Enforce: true,
		Title: "10% used", Message: "You've used some of this week's Claude budget."}
}

func warnStatus() Status {
	s := okStatus(85)
	s.State = "warn"
	s.Message = "Heads up: you've used 85% of this week's Claude budget. It resets on Monday at 9:30 PM."
	return s
}

func overStatus() Status {
	s := okStatus(104)
	s.State = "over"
	s.Enforce = false
	s.Message = "You're over this week's Claude budget (monitor only, nothing is blocked)."
	return s
}

func blockedStatus() Status {
	s := okStatus(104)
	s.Allowed = false
	s.State = "blocked"
	s.Message = "You've used all of this week's Claude budget. It resets on Monday at 9:30 PM."
	return s
}

type testApp struct {
	*App
	out   *bytes.Buffer
	clock time.Time
}

func newTestApp(t *testing.T) *testApp {
	t.Helper()
	root := t.TempDir()
	ta := &testApp{out: &bytes.Buffer{}, clock: time.Now()}
	ta.App = &App{
		GOOS:      "darwin",
		SysDir:    filepath.Join(root, "sys"),
		StateDir:  filepath.Join(root, "state"),
		NoService: true,
		TestMode:  true,
		HTTP:      &http.Client{Timeout: 5 * time.Second},
		In:        strings.NewReader(""),
		Out:       ta.out,
		Err:       io.Discard,
	}
	ta.App.Now = func() time.Time { return ta.clock }
	return ta
}

// install writes a config + drop-in as if `clare enroll` had run.
func (ta *testApp) install(t *testing.T, api string) *Config {
	t.Helper()
	cfg := &Config{API: api, Token: "clr_test", DeviceID: "dev1", Label: "Test Mac",
		EnrolledAt: ta.clock.Add(-time.Hour).UTC().Format(time.RFC3339), StrictHooks: true}
	if err := os.MkdirAll(ta.clareDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := ta.saveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ta.binPath(), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := ta.writeDropIn(true); err != nil {
		t.Fatal(err)
	}
	return cfg
}

// hook runs `clare hook <event>` with a JSON payload and returns stdout.
func (ta *testApp) hook(t *testing.T, event string, payload map[string]any) string {
	t.Helper()
	data, _ := json.Marshal(payload)
	ta.In = bytes.NewReader(data)
	ta.out.Reset()
	if code := ta.run([]string{"hook", event}); code != 0 {
		t.Fatalf("hook %s exited %d", event, code)
	}
	return ta.out.String()
}

// assistantLine builds one transcript line the way Claude Code writes it.
func assistantLine(id, model string, in, out, cr, cw, cw1h int64, ts time.Time) string {
	m := map[string]any{
		"type":      "assistant",
		"timestamp": ts.UTC().Format(time.RFC3339Nano),
		"requestId": "req_" + id,
		"message": map[string]any{
			"id": id, "model": model, "role": "assistant",
			"content": []any{map[string]any{"type": "text", "text": "hello"}},
			"usage": map[string]any{
				"input_tokens": in, "output_tokens": out,
				"cache_read_input_tokens": cr, "cache_creation_input_tokens": cw,
				"cache_creation": map[string]any{"ephemeral_1h_input_tokens": cw1h, "ephemeral_5m_input_tokens": cw - cw1h},
			},
		},
	}
	b, _ := json.Marshal(m)
	return string(b) + "\n"
}

func userLine(text string) string {
	b, _ := json.Marshal(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": text}})
	return string(b) + "\n"
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func appendFile(t *testing.T, path, content string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(content); err != nil {
		t.Fatal(err)
	}
}
