package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Event is one assistant message's token usage, as sent to POST /report.
type Event struct {
	Key          string `json:"key"`
	Model        string `json:"model"`
	Input        int64  `json:"input"`
	Output       int64  `json:"output"`
	CacheRead    int64  `json:"cache_read"`
	CacheWrite   int64  `json:"cache_write"`
	CacheWrite1h int64  `json:"cache_write_1h"`
	At           string `json:"at"`
	Estimated    bool   `json:"estimated"`
}

// transcriptLine is the subset of a Claude Code transcript line we need.
type transcriptLine struct {
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	Message   *struct {
		ID    string `json:"id"`
		Model string `json:"model"`
		Usage *struct {
			InputTokens              int64 `json:"input_tokens"`
			OutputTokens             int64 `json:"output_tokens"`
			CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
			CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
			CacheCreation            *struct {
				Ephemeral1h int64 `json:"ephemeral_1h_input_tokens"`
			} `json:"cache_creation"`
		} `json:"usage"`
	} `json:"message"`
}

var (
	markUsage     = []byte(`"usage"`)
	markAssistant = []byte(`"assistant"`)
)

// parseUsageLine turns one transcript line into an Event, if it carries usage.
func parseUsageLine(line []byte) (Event, bool) {
	// Cheap pre-filter: most lines (tool results, user turns) have no usage.
	if !bytes.Contains(line, markUsage) || !bytes.Contains(line, markAssistant) {
		return Event{}, false
	}
	var l transcriptLine
	if json.Unmarshal(line, &l) != nil || l.Type != "assistant" || l.Message == nil || l.Message.Usage == nil || l.Message.ID == "" {
		return Event{}, false
	}
	if l.Message.Model == "<synthetic>" {
		return Event{}, false
	}
	u := l.Message.Usage
	if u.InputTokens+u.OutputTokens+u.CacheReadInputTokens+u.CacheCreationInputTokens == 0 {
		return Event{}, false
	}
	ev := Event{
		Key:        "cc:" + l.Message.ID,
		Model:      l.Message.Model,
		Input:      u.InputTokens,
		Output:     u.OutputTokens,
		CacheRead:  u.CacheReadInputTokens,
		CacheWrite: u.CacheCreationInputTokens,
		At:         l.Timestamp,
	}
	if u.CacheCreation != nil {
		ev.CacheWrite1h = u.CacheCreation.Ephemeral1h
	}
	return ev, true
}

// scanFile reads complete lines of a transcript from offset and returns usage
// events made from since until until (zero: no bound) plus the offset just past the
// last complete line. A partial last line (still being written) is left for next
// time. It streams, so huge transcripts are fine, and stops early (done=false) when
// the deadline passes.
func scanFile(path string, offset int64, since, until time.Time, deadline time.Time) (events []Event, newOffset int64, done bool, err error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, offset, true, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, offset, true, err
	}
	if st.Size() < offset {
		offset = 0 // file was truncated or replaced
	}
	if st.Size() == offset {
		return nil, offset, true, nil
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return nil, offset, true, err
	}

	r := bufio.NewReaderSize(f, 256<<10)
	pos := offset
	seen := map[string]bool{}
	for n := 0; ; n++ {
		if n%256 == 0 && !deadline.IsZero() && time.Now().After(deadline) {
			return events, pos, false, nil
		}
		line, err := r.ReadBytes('\n')
		if err != nil {
			// io.EOF with a partial line: don't consume it.
			if err == io.EOF {
				return events, pos, true, nil
			}
			return events, pos, false, err
		}
		pos += int64(len(line))

		ev, ok := parseUsageLine(line)
		if !ok || seen[ev.Key] {
			continue
		}
		seen[ev.Key] = true
		if !since.IsZero() || !until.IsZero() {
			if t, err := time.Parse(time.RFC3339Nano, ev.At); err == nil && (t.Before(since) || !until.IsZero() && !t.Before(until)) {
				continue
			}
		}
		events = append(events, ev)
	}
}

// sessionFiles returns the session's transcript and its subagent transcripts,
// which live in <dir>/<session_id>/subagents/*.jsonl.
func sessionFiles(transcriptPath, sessionID string) []string {
	if transcriptPath == "" {
		return nil
	}
	files := []string{transcriptPath}
	if sessionID != "" {
		dir := filepath.Join(filepath.Dir(transcriptPath), sessionID, "subagents")
		if matches, err := filepath.Glob(filepath.Join(dir, "*.jsonl")); err == nil {
			files = append(files, matches...)
		}
	}
	return files
}

// sessionOf is the session a transcript belongs to: <dir>/<id>.jsonl, or a subagent's
// <dir>/<id>/subagents/agent-….jsonl.
func sessionOf(path string) string {
	if dir := filepath.Dir(path); filepath.Base(dir) == "subagents" {
		return filepath.Base(filepath.Dir(dir))
	}
	return strings.TrimSuffix(filepath.Base(path), ".jsonl")
}
