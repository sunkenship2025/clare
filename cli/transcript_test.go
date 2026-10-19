package main

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestScanFileDedupesAndKeepsPartialLine(t *testing.T) {
	now := time.Now()
	dir := t.TempDir()
	path := filepath.Join(dir, "s1.jsonl")

	a := assistantLine("msg_A", "claude-opus-5-5", 2, 100, 5000, 300, 300, now)
	b := assistantLine("msg_B", "claude-sonnet-5-5", 10, 20, 0, 0, 0, now)
	synthetic := assistantLine("msg_S", "<synthetic>", 1, 1, 0, 0, 0, now)
	zero := assistantLine("msg_Z", "claude-opus-5-5", 0, 0, 0, 0, 0, now)
	c := assistantLine("msg_C", "claude-haiku-5-5", 1, 2, 3, 4, 0, now)
	partial := c[:len(c)/2] // still being written

	content := userLine("hi") + a + a + a + b + synthetic + zero + partial
	writeFile(t, path, content)

	events, off, done, err := scanFile(path, 0, time.Time{}, time.Time{}, time.Time{})
	if err != nil || !done {
		t.Fatalf("scan: err=%v done=%v", err, done)
	}
	if len(events) != 2 || events[0].Key != "cc:msg_A" || events[1].Key != "cc:msg_B" {
		t.Fatalf("want A,B got %+v", events)
	}
	if e := events[0]; e.Model != "claude-opus-5-5" || e.Input != 2 || e.Output != 100 || e.CacheRead != 5000 || e.CacheWrite != 300 || e.CacheWrite1h != 300 {
		t.Fatalf("bad tokens: %+v", e)
	}
	wantOff := int64(len(content) - len(partial))
	if off != wantOff {
		t.Fatalf("offset %d, want %d (partial line must not be consumed)", off, wantOff)
	}

	// The rest of the line arrives, plus a new message.
	d := assistantLine("msg_D", "claude-opus-5-5", 1, 1, 1, 1, 0, now)
	appendFile(t, path, c[len(c)/2:]+d)
	events, off2, _, err := scanFile(path, off, time.Time{}, time.Time{}, time.Time{})
	if err != nil || len(events) != 2 || events[0].Key != "cc:msg_C" || events[1].Key != "cc:msg_D" {
		t.Fatalf("second scan: %v %+v", err, events)
	}
	st, _ := os.Stat(path)
	if off2 != st.Size() {
		t.Fatalf("offset %d, want EOF %d", off2, st.Size())
	}
}

func TestScanFileSinceAndTruncation(t *testing.T) {
	now := time.Now()
	path := filepath.Join(t.TempDir(), "s.jsonl")
	old := assistantLine("old", "claude-opus-5-5", 1, 1, 0, 0, 0, now.Add(-48*time.Hour))
	fresh := assistantLine("new", "claude-opus-5-5", 1, 1, 0, 0, 0, now)
	writeFile(t, path, old+fresh)

	events, _, _, _ := scanFile(path, 0, now.Add(-time.Hour), time.Time{}, time.Time{})
	if len(events) != 1 || events[0].Key != "cc:new" {
		t.Fatalf("since filter: %+v", events)
	}

	// Offset beyond EOF (file replaced) restarts from 0.
	events, _, _, _ = scanFile(path, 1<<20, time.Time{}, time.Time{}, time.Time{})
	if len(events) != 2 {
		t.Fatalf("truncation reset: %+v", events)
	}
}

func TestScanFileHandlesHugeLines(t *testing.T) {
	now := time.Now()
	path := filepath.Join(t.TempDir(), "big.jsonl")
	huge := userLine(strings.Repeat("x", 3<<20)) // 3 MB tool result
	writeFile(t, path, huge+assistantLine("after", "claude-opus-5-5", 1, 2, 0, 0, 0, now))
	events, _, done, err := scanFile(path, 0, time.Time{}, time.Time{}, time.Time{})
	if err != nil || !done || len(events) != 1 {
		t.Fatalf("huge line: err=%v done=%v events=%+v", err, done, events)
	}
}

func TestSessionFilesIncludesSubagents(t *testing.T) {
	dir := t.TempDir()
	main := filepath.Join(dir, "abc.jsonl")
	writeFile(t, main, "")
	writeFile(t, filepath.Join(dir, "abc", "subagents", "agent-1.jsonl"), "")
	writeFile(t, filepath.Join(dir, "abc", "subagents", "agent-2.jsonl"), "")
	writeFile(t, filepath.Join(dir, "abc", "subagents", "notes.txt"), "")
	files := sessionFiles(main, "abc")
	if len(files) != 3 {
		t.Fatalf("want main + 2 subagents, got %v", files)
	}
}

func TestCollectQueuesSubagentUsageOnceAndSkipsPreEnroll(t *testing.T) {
	ta := newTestApp(t)
	cfg := ta.install(t, "http://127.0.0.1:1")
	dir := t.TempDir()
	main := filepath.Join(dir, "s.jsonl")
	writeFile(t, main, assistantLine("m1", "claude-opus-5-5", 1, 10, 0, 0, 0, ta.clock)+
		assistantLine("before_enroll", "claude-opus-5-5", 1, 10, 0, 0, 0, ta.clock.Add(-2*time.Hour)))
	writeFile(t, filepath.Join(dir, "s", "subagents", "agent-a.jsonl"), assistantLine("sub1", "claude-haiku-5-5", 5, 5, 0, 0, 0, ta.clock))

	files := sessionFiles(main, "s")
	ta.collect(cfg, files, time.Second, false)
	ta.collect(cfg, files, time.Second, true) // nothing new: no duplicates
	q := ta.loadMeter().Queue
	if len(q) != 2 {
		t.Fatalf("want m1 + sub1 queued once, got %+v", q)
	}
}

// TestRealTranscriptSmoke parses a copy of a real Claude Code transcript from this
// machine, if one exists. It never touches the original.
func TestRealTranscriptSmoke(t *testing.T) {
	home, _ := os.UserHomeDir()
	matches, _ := filepath.Glob(filepath.Join(home, ".claude", "projects", "*", "*.jsonl"))
	var src string
	for _, m := range matches {
		if st, err := os.Stat(m); err == nil && st.Size() > 10<<10 && st.Size() < 5<<20 {
			src = m
			break
		}
	}
	if src == "" {
		t.Skip("no real transcript on this machine")
	}
	dst := filepath.Join(t.TempDir(), "copy.jsonl")
	if err := copyFile(src, dst, 0o600); err != nil {
		t.Fatal(err)
	}

	// Independent count of distinct message ids with usage.
	f, _ := os.Open(dst)
	defer f.Close()
	ids := map[string]bool{}
	r := bufio.NewReaderSize(f, 1<<20)
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			break
		}
		if ev, ok := parseUsageLine(line); ok {
			ids[ev.Key] = true
		}
	}

	events, _, done, err := scanFile(dst, 0, time.Time{}, time.Time{}, time.Time{})
	if err != nil || !done {
		t.Fatalf("scan real transcript: %v", err)
	}
	if len(events) != len(ids) {
		t.Fatalf("got %d events, want %d distinct messages", len(events), len(ids))
	}
	var out int64
	for _, e := range events {
		if !strings.HasPrefix(e.Key, "cc:") || e.Model == "" {
			t.Fatalf("bad event %+v", e)
		}
		out += e.Output
	}
	t.Logf("real transcript: %d messages, %d output tokens", len(events), out)
}
