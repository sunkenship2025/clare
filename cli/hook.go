package main

import (
	"encoding/json"
	"io"
	"strings"
	"time"
)

// Claude Code runs `clare hook <Event>` with a JSON payload on stdin.
// Hooks must be fast, must never crash, and must exit 0. Blocking is expressed
// only through the JSON we print, and follows the cached-policy strategy in
// docs/ARCHITECTURE.md: never block because of a network, sign-in or setup problem.

type hookInput struct {
	SessionID      string `json:"session_id"`
	TranscriptPath string `json:"transcript_path"`
	HookEventName  string `json:"hook_event_name"`
}

const (
	toolSyncEvery = 30 * time.Second // PreToolUse re-checks the server at most this often

	brokenMessage   = "clare's settings on this computer are missing or damaged, so this computer's Claude usage isn't being tracked. To fix it, run:  sudo clare doctor"
	revokedMessage  = "This device was removed from clare, so it no longer tracks usage or enforces your budget here. clare uninstalls itself within a few minutes. To add it back, use \"Add a device\" in the clare dashboard."
	rejectedMessage = "The clare server didn't accept this computer's sign-in, so usage here isn't being tracked. To fix it, run:  sudo clare doctor"
)

func (a *App) runHook(event string) int {
	var in hookInput
	data, _ := io.ReadAll(io.LimitReader(a.In, 16<<20))
	_ = json.Unmarshal(data, &in)
	if event == "" {
		event = in.HookEventName
	}
	speaks := event == "SessionStart" || event == "UserPromptSubmit"

	cfg, err := a.loadConfig()
	if err != nil {
		// Installed (drop-in present) but the config is gone or damaged: a health
		// problem, not a reason to stop Claude Code. Say so once per session.
		if speaks && fileExists(a.dropInPath()) && a.firstTime("broken", in.SessionID) {
			a.emit(map[string]any{"systemMessage": "clare: " + brokenMessage})
		}
		return 0
	}
	if !cfg.profileCovered() {
		return 0 // another Claude Code profile (another account): not clare's business
	}

	files := sessionFiles(in.TranscriptPath, in.SessionID)
	now := a.Now()
	switch event {
	case "SessionStart", "UserPromptSubmit":
		scan, net := 1500*time.Millisecond, 3*time.Second
		if event == "SessionStart" {
			scan, net = 2*time.Second, 4*time.Second
		}
		fresh, err := a.sync(cfg, files, scan, net, event == "SessionStart")
		st, at := a.current(fresh, err)

		var notes []string
		if note := healthNote(err); note != "" && a.firstTime(note, in.SessionID) {
			notes = append(notes, healthMessage(note))
		}
		blocked := blocks(st, at, now)
		if blocked && event == "UserPromptSubmit" {
			a.emit(map[string]any{"decision": "block", "reason": st.Message})
			return 0
		}
		switch {
		case blocked:
			notes = append(notes, st.Message) // SessionStart can only tell, not block
		case st != nil && (st.State == "warn" || st.State == "over") && a.firstTime(st.State, in.SessionID):
			notes = append(notes, st.Message)
		}
		if len(notes) > 0 {
			a.emit(map[string]any{"systemMessage": "clare: " + strings.Join(notes, "\n")})
		}

	case "PreToolUse":
		cache := a.loadStatusCache()
		st, at := cache.Status, cache.FetchedAt
		if now.Sub(cache.LastSyncAt) >= toolSyncEvery {
			fresh, err := a.sync(cfg, files, time.Second, 2*time.Second, false)
			st, at = a.current(fresh, err)
		}
		if blocks(st, at, now) {
			a.emit(denyTool(st.Message))
		}

	case "Stop", "SubagentStop", "SessionEnd":
		_, _ = a.sync(cfg, files, 3*time.Second, 4*time.Second, event == "SessionEnd")
	}
	return 0
}

// current returns the status to act on and when it was fetched: the fresh one,
// else the cache when the server couldn't be reached. A removed device or a
// rejected sign-in has no policy at all, so nothing is blocked.
func (a *App) current(st *Status, err error) (*Status, time.Time) {
	if err == nil && st != nil {
		return st, a.Now()
	}
	if isRevoked(err) || isUnauthorized(err) {
		return nil, time.Time{}
	}
	cache := a.loadStatusCache()
	if cache.Revoked {
		return nil, time.Time{}
	}
	return cache.Status, cache.FetchedAt
}

// healthNote names a server answer worth mentioning once per session.
func healthNote(err error) string {
	switch {
	case isRevoked(err):
		return "revoked"
	case isUnauthorized(err):
		return "rejected"
	}
	return ""
}

func healthMessage(note string) string {
	if note == "revoked" {
		return revokedMessage
	}
	return rejectedMessage
}

// denyTool stops a running agent turn: the tool call is denied and Claude stops.
func denyTool(msg string) map[string]any {
	return map[string]any{
		"continue":   false,
		"stopReason": msg,
		"hookSpecificOutput": map[string]any{
			"hookEventName":            "PreToolUse",
			"permissionDecision":       "deny",
			"permissionDecisionReason": msg,
		},
	}
}

func (a *App) emit(v any) {
	data, _ := json.Marshal(v)
	a.Out.Write(data)
}

// firstTime records that this session was told about kind, and reports whether
// it's the first time. Without a session id it always says yes.
func (a *App) firstTime(kind, session string) bool {
	if session == "" {
		return true
	}
	c := a.loadStatusCache()
	key := kind + ":" + session
	if _, seen := c.Notified[key]; seen {
		return false
	}
	c.Notified[key] = a.Now()
	a.saveStatusCache(c)
	return true
}
