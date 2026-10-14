package main

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// Reading is the canonical official-meter reading (docs/ARCHITECTURE.md → Metering).
// `clare statusline` saves the newest one in the user state dir; hooks send it with /report.
type Reading struct {
	At       string       `json:"at"`
	SevenDay *MeterWindow `json:"seven_day"`
	FiveHour *MeterWindow `json:"five_hour,omitempty"`
}

type MeterWindow struct {
	Pct      float64 `json:"pct"`
	ResetsAt string  `json:"resets_at"`
}

// readingResend: an unchanged reading is sent again at most this often, so the
// dashboard's "checked … ago" stays fresh without a request on every hook.
const readingResend = 10 * time.Minute

// readingID identifies a reading's numbers, ignoring when it was taken.
func readingID(r *Reading) string {
	id := fmt.Sprintf("%g|%s", r.SevenDay.Pct, r.SevenDay.ResetsAt)
	if r.FiveHour != nil {
		id += fmt.Sprintf("|%g|%s", r.FiveHour.Pct, r.FiveHour.ResetsAt)
	}
	return id
}

func (a *App) loadReading() *Reading {
	var r Reading
	if readJSONFile(a.statePath("reading.json"), &r) != nil || r.SevenDay == nil || r.SevenDay.ResetsAt == "" {
		return nil
	}
	return &r
}

// unsentReading returns the saved reading when the server hasn't seen it yet:
// its numbers changed, or it's a newer reading of the same numbers and the last
// send was a while ago. Readings for a week that has already reset are dropped.
func (a *App) unsentReading(m *meterState) *Reading {
	r := a.loadReading()
	if r == nil {
		return nil
	}
	now := a.Now()
	if t, err := time.Parse(time.RFC3339, r.SevenDay.ResetsAt); err != nil || !now.Before(t) {
		return nil
	}
	if t, err := time.Parse(time.RFC3339, r.At); err == nil && now.Sub(t) > 24*time.Hour {
		return nil
	}
	if readingID(r) != m.ReadingID {
		return r
	}
	if r.At != m.ReadingTS && now.Sub(m.ReadingAt) >= readingResend {
		return r
	}
	return nil
}

func (a *App) markReadingSent(r *Reading) {
	release, ok := a.lock(time.Second)
	if !ok {
		return // sent again next time; the server ignores repeats
	}
	defer release()
	m := a.loadMeter()
	m.ReadingID = readingID(r)
	m.ReadingTS = r.At
	m.ReadingAt = a.Now()
	_ = a.saveMeter(m)
}

// parseRateLimits turns Claude Code's status-line `rate_limits` into a Reading.
// Lenient: percentages as used_percentage / utilization / pct, reset times as
// epoch seconds, epoch milliseconds, numeric strings, or ISO timestamps.
func parseRateLimits(raw map[string]json.RawMessage, now time.Time) *Reading {
	week := parseWindow(raw["seven_day"])
	if week == nil {
		return nil
	}
	return &Reading{
		At:       now.UTC().Format(time.RFC3339),
		SevenDay: week,
		FiveHour: parseWindow(raw["five_hour"]),
	}
}

func parseWindow(raw json.RawMessage) *MeterWindow {
	if len(raw) == 0 {
		return nil
	}
	var w map[string]any
	if json.Unmarshal(raw, &w) != nil || w == nil {
		return nil
	}
	pct, ok := number(firstPresent(w, "used_percentage", "utilization", "pct"))
	if !ok || pct < 0 || pct > 1000 {
		return nil
	}
	resets, ok := timestamp(firstPresent(w, "resets_at", "resetsAt", "reset_at"))
	if !ok {
		return nil
	}
	return &MeterWindow{Pct: pct, ResetsAt: resets.UTC().Format(time.RFC3339)}
}

func firstPresent(m map[string]any, keys ...string) any {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			return v
		}
	}
	return nil
}

func number(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, !math.IsNaN(x) && !math.IsInf(x, 0)
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return f, err == nil && !math.IsNaN(f) && !math.IsInf(f, 0)
	}
	return 0, false
}

// timestamp accepts epoch seconds or milliseconds (number or numeric string) and ISO 8601.
func timestamp(v any) (time.Time, bool) {
	if s, ok := v.(string); ok {
		s = strings.TrimSpace(s)
		if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
			return t, true
		}
	}
	f, ok := number(v)
	if !ok || f <= 0 {
		return time.Time{}, false
	}
	if f > 1e12 {
		return time.UnixMilli(int64(f)), true
	}
	return time.Unix(int64(f), 0), true
}
