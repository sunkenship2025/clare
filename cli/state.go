package main

import (
	"fmt"
	"os"
	"time"
)

// Per-user state lives in StateDir (writable without root):
//
//	status.json   last status from the server + throttle and once-per-session bookkeeping
//	meter.json    transcript byte offsets + queue of not-yet-accepted events + last meter reading sent
//	reading.json  newest official meter reading, written by `clare statusline`
//	meter.lock    cross-process lock (parallel tool calls run hooks concurrently)

type statusCache struct {
	Status     *Status              `json:"status"`
	FetchedAt  time.Time            `json:"fetched_at"`
	LastSyncAt time.Time            `json:"last_sync_at"` // last attempt, success or not (PreToolUse throttle)
	Revoked    bool                 `json:"revoked,omitempty"`
	Notified   map[string]time.Time `json:"notified"` // "<kind>:<session>" → when we told that session
}

func (a *App) loadStatusCache() *statusCache {
	c := &statusCache{}
	if err := readJSONFile(a.statePath("status.json"), c); (err != nil || c.Status == nil) && !c.Revoked {
		// Fall back to what the root watchdog last saw.
		var sys statusCache
		if readJSONFile(a.systemStatusPath(), &sys) == nil && sys.Status != nil {
			c.Status = sys.Status
			c.FetchedAt = sys.FetchedAt
		}
	}
	if c.Notified == nil {
		c.Notified = map[string]time.Time{}
	}
	return c
}

func (a *App) saveStatusCache(c *statusCache) {
	cutoff := a.Now().Add(-7 * 24 * time.Hour)
	for k, t := range c.Notified {
		if t.Before(cutoff) {
			delete(c.Notified, k)
		}
	}
	_ = writeJSONAtomic(a.statePath("status.json"), c, 0o600)
}

// meterState tracks how far we've read each transcript and what's still unsent.
type meterState struct {
	Offsets   map[string]int64 `json:"offsets"`
	Queue     []Event          `json:"queue"`
	Recent    []string         `json:"recent"`               // keys the server already accepted (ring)
	ReadingID string           `json:"reading_id,omitempty"` // readingID of the last meter reading the server accepted
	ReadingTS string           `json:"reading_ts,omitempty"` // that reading's own "at"
	ReadingAt time.Time        `json:"reading_at,omitempty"` // when we sent it
}

const (
	maxQueue  = 5000
	maxRecent = 2000
	batchSize = 500
)

func (a *App) loadMeter() *meterState {
	m := &meterState{}
	_ = readJSONFile(a.statePath("meter.json"), m)
	if m.Offsets == nil {
		m.Offsets = map[string]int64{}
	}
	return m
}

func (a *App) saveMeter(m *meterState) error {
	return writeJSONAtomic(a.statePath("meter.json"), m, 0o600)
}

// lock takes a simple cross-platform lock file. Stale locks (crashed hook) expire.
func (a *App) lock(wait time.Duration) (release func(), ok bool) {
	if err := os.MkdirAll(a.StateDir, 0o700); err != nil {
		return nil, false
	}
	path := a.statePath("meter.lock")
	deadline := time.Now().Add(wait)
	for {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			fmt.Fprintf(f, "%d", os.Getpid())
			f.Close()
			return func() { os.Remove(path) }, true
		}
		if st, e := os.Stat(path); e == nil && time.Since(st.ModTime()) > 15*time.Second {
			os.Remove(path)
			continue
		}
		if time.Now().After(deadline) {
			return nil, false
		}
		time.Sleep(15 * time.Millisecond)
	}
}

// collect scans transcripts for new usage and appends it to the queue.
// With sweep, it also re-checks every transcript we've seen before, which
// catches sessions that ended without a Stop hook (closed terminal, Esc).
func (a *App) collect(cfg *Config, files []string, budget time.Duration, sweep bool) {
	release, ok := a.lock(500 * time.Millisecond)
	if !ok {
		return
	}
	defer release()

	m := a.loadMeter()
	now := a.Now()
	deadline := time.Now().Add(budget)

	// Usage before this computer was enrolled, or older than the server keeps, is not counted.
	since := now.Add(-8 * 24 * time.Hour)
	if j := cfg.enrolledAt(); j.After(since) {
		since = j
	}

	todo := append([]string{}, files...)
	if sweep {
		for p := range m.Offsets {
			todo = append(todo, p)
		}
	}

	recent := make(map[string]bool, len(m.Recent)+len(m.Queue))
	for _, k := range m.Recent {
		recent[k] = true
	}
	for _, e := range m.Queue {
		recent[e.Key] = true
	}

	visited := map[string]bool{}
	for _, path := range todo {
		if visited[path] || path == "" {
			continue
		}
		visited[path] = true

		st, err := os.Stat(path)
		if err != nil {
			delete(m.Offsets, path) // transcript is gone
			continue
		}
		off, known := m.Offsets[path]
		if !known && st.ModTime().Before(since) {
			// Untouched since before we started counting: nothing to read.
			m.Offsets[path] = st.Size()
			continue
		}
		if known && st.Size() == off {
			if now.Sub(st.ModTime()) > 30*24*time.Hour {
				delete(m.Offsets, path) // forget long-finished sessions
			}
			continue
		}
		if time.Now().After(deadline) {
			continue // out of time; next hook picks it up
		}

		events, newOff, _, err := scanFile(path, off, since, deadline)
		if err != nil && len(events) == 0 && newOff == off {
			continue
		}
		m.Offsets[path] = newOff
		for _, e := range events {
			if !recent[e.Key] {
				recent[e.Key] = true
				m.Queue = append(m.Queue, e)
			}
		}
	}
	if len(m.Queue) > maxQueue {
		m.Queue = m.Queue[len(m.Queue)-maxQueue:]
	}
	_ = a.saveMeter(m)
}

// markSent removes accepted events from the queue and remembers their keys.
func (a *App) markSent(keys []string) {
	release, ok := a.lock(time.Second)
	if !ok {
		return // they'll be re-sent; the server ignores duplicates
	}
	defer release()
	m := a.loadMeter()
	sent := make(map[string]bool, len(keys))
	for _, k := range keys {
		sent[k] = true
	}
	kept := m.Queue[:0]
	for _, e := range m.Queue {
		if !sent[e.Key] {
			kept = append(kept, e)
		}
	}
	m.Queue = kept
	m.Recent = append(m.Recent, keys...)
	if len(m.Recent) > maxRecent {
		m.Recent = m.Recent[len(m.Recent)-maxRecent:]
	}
	_ = a.saveMeter(m)
}

// sync = collect new usage, send everything queued plus any new meter reading
// (or just /check), cache the status. It never blocks for long: scanning has a
// time budget and the network a timeout.
func (a *App) sync(cfg *Config, files []string, scanBudget, netTimeout time.Duration, sweep bool) (*Status, error) {
	a.collect(cfg, files, scanBudget, sweep)

	c := a.client(cfg.API, cfg.Token)
	deadline := time.Now().Add(netTimeout)
	m := a.loadMeter()
	queue := m.Queue
	reading := a.unsentReading(m)

	var st *Status
	var err error
	if len(queue) == 0 && reading == nil {
		var resp statusResponse
		err = c.call(netTimeout, "POST", "/check", map[string]any{}, &resp)
		st = resp.Status
	} else {
		for len(queue) > 0 || reading != nil {
			n := min(batchSize, len(queue))
			batch := queue[:n]
			left := time.Until(deadline)
			if left < 200*time.Millisecond {
				break
			}
			body := map[string]any{"events": batch}
			if reading != nil {
				body["meter"] = reading
			}
			var resp statusResponse
			if err = c.call(left, "POST", "/report", body, &resp); err != nil {
				break
			}
			if n > 0 {
				keys := make([]string, n)
				for i, e := range batch {
					keys[i] = e.Key
				}
				a.markSent(keys)
			}
			if reading != nil {
				a.markReadingSent(reading)
				reading = nil
			}
			st = resp.Status
			queue = queue[n:]
		}
	}

	cache := a.loadStatusCache()
	cache.LastSyncAt = a.Now()
	switch {
	case err == nil && st != nil:
		cache.Status = st
		cache.FetchedAt = a.Now()
		cache.Revoked = false
	case isRevoked(err):
		// Removed in the dashboard: stop enforcing right away. The watchdog uninstalls clare.
		cache.Status = nil
		cache.Revoked = true
	}
	a.saveStatusCache(cache)
	if err != nil {
		return nil, err
	}
	return st, nil
}

// cachedPolicyMaxAge: an offline "blocked" older than this no longer blocks.
const cachedPolicyMaxAge = 24 * time.Hour

// blocks is the cached-policy strategy (docs/ARCHITECTURE.md): stop Claude Code only
// for a "blocked" status whose week hasn't rolled over and that is less than 24 h old.
// A fresh status has fetchedAt = now, so online this is simply state == "blocked".
func blocks(s *Status, fetchedAt, now time.Time) bool {
	if s == nil || s.State != "blocked" {
		return false
	}
	if t, ok := s.resetsAt(); ok && !now.Before(t) {
		return false
	}
	return !fetchedAt.IsZero() && now.Sub(fetchedAt) < cachedPolicyMaxAge
}
