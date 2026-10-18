package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Status mirrors the status object in docs/ARCHITECTURE.md.
type Status struct {
	Allowed     bool       `json:"allowed"`
	State       string     `json:"state"`    // ok | warn | over | blocked
	Basis       string     `json:"basis"`    // meter | estimate
	MeterAt     *string    `json:"meter_at"` // when Claude's official meter was last read; nil on estimates and older servers
	Scope       string     `json:"scope"`    // account | group | device: which limit Used/Limit/Pct describe
	Used        float64    `json:"used"`     // points (1 point = 1% of the weekly limit)
	Limit       float64    `json:"limit"`
	Pct         float64    `json:"pct"`
	Account     AccountUse `json:"account"`
	Group       *GroupUse  `json:"group"`
	Device      *DeviceUse `json:"device"`
	ResetsAt    string     `json:"resets_at"`
	Enforce     bool       `json:"enforce"`
	StrictHooks bool       `json:"strict_hooks"`
	Title       string     `json:"title"`
	Message     string     `json:"message"`
}

// AccountUse is the whole account against the weekly budget, in points.
type AccountUse struct {
	Used   float64 `json:"used"`
	Budget float64 `json:"budget"`
	Pct    float64 `json:"pct"`
}

// GroupUse is this device's group against its share of the weekly limit, in points; nil outside a group.
type GroupUse struct {
	ID     string  `json:"id"`
	Label  string  `json:"label"`
	Used   float64 `json:"used"`
	Budget float64 `json:"budget"`
	Pct    float64 `json:"pct"`
}

// groupPhrase is "the pranav group", or "the Work group" when the name already says it's a group.
func groupPhrase(label string) string {
	name := strings.TrimSpace(label)
	if name == "" {
		return "the group"
	}
	if lower := strings.ToLower(name); lower == "group" || strings.HasSuffix(lower, " group") {
		return "the " + name
	}
	return "the " + name + " group"
}

// DeviceUse is this device's part of the week's usage; Budget and Pct are nil without a device cap.
type DeviceUse struct {
	ID     string   `json:"id"`
	Label  string   `json:"label"`
	Used   float64  `json:"used"`
	Budget *float64 `json:"budget"`
	Pct    *float64 `json:"pct"`
}

func (s *Status) resetsAt() (time.Time, bool) {
	if s == nil || s.ResetsAt == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339, s.ResetsAt)
	return t, err == nil
}

// meterStaleAfter: a meter reading older than this may be missing usage on devices without clare.
// After meterAlertAfter (as long as the server's meter_stale alert) Claude Code sessions are told.
const (
	meterStaleAfter = time.Hour
	meterAlertAfter = 24 * time.Hour
)

// meterAge is how long ago Claude's official meter was last read, when the server says.
func (s *Status) meterAge(now time.Time) (time.Duration, bool) {
	if s == nil || s.MeterAt == nil {
		return 0, false
	}
	t, err := time.Parse(time.RFC3339, *s.MeterAt)
	if err != nil {
		return 0, false
	}
	return max(0, now.Sub(t)), true
}

// APIError is a non-2xx answer from the server.
type APIError struct {
	HTTPStatus int
	Code       string `json:"error"`
	Message    string `json:"message"`
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return fmt.Sprintf("server said %d %s", e.HTTPStatus, e.Code)
}

// OfflineError means the server could not be reached at all.
type OfflineError struct{ Err error }

func (e *OfflineError) Error() string { return "can't reach the clare server: " + e.Err.Error() }
func (e *OfflineError) Unwrap() error { return e.Err }

func isOffline(err error) bool {
	var oe *OfflineError
	return errors.As(err, &oe)
}

// isRevoked: this device was removed in the dashboard.
func isRevoked(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.HTTPStatus == http.StatusGone && ae.Code == "revoked"
}

// isUnauthorized: the server doesn't know this device's token.
func isUnauthorized(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.HTTPStatus == http.StatusUnauthorized
}

func apiErrorCode(err error) string {
	var ae *APIError
	if errors.As(err, &ae) {
		return ae.Code
	}
	return ""
}

type apiClient struct {
	base  string
	token string
	http  *http.Client
}

func (a *App) client(base, token string) *apiClient {
	return &apiClient{base: strings.TrimRight(base, "/"), token: token, http: a.HTTP}
}

// call does one JSON request with its own timeout.
func (c *apiClient) call(timeout time.Duration, method, path string, body, out any) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	var rd io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		return &OfflineError{err}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "clare-cli/"+version)
	req.Header.Set("X-Clare-TZ", ianaTimezone())
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return &OfflineError{err}
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return &OfflineError{err}
	}

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		ae := &APIError{HTTPStatus: resp.StatusCode}
		_ = json.Unmarshal(data, ae)
		// A proxy/gateway error page is as good as offline: don't act on it.
		if ae.Code == "" && resp.StatusCode >= 500 {
			return &OfflineError{ae}
		}
		return ae
	}
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return &OfflineError{fmt.Errorf("unexpected answer from server: %w", err)}
		}
	}
	return nil
}

type enrollRequest struct {
	Code  string         `json:"code"`
	Kind  string         `json:"kind"`
	Label string         `json:"label"`
	Info  map[string]any `json:"info"`
}

type enrollResponse struct {
	Token     string  `json:"token"`
	DeviceID  string  `json:"device_id"`
	ByeSecret string  `json:"bye_secret"`
	Status    *Status `json:"status"`
}

type statusResponse struct {
	Accepted int     `json:"accepted"`
	Status   *Status `json:"status"`
}

type heartbeatRequest struct {
	Info   map[string]any `json:"info"`
	Health health         `json:"health"`
}

type health struct {
	OK       bool     `json:"ok"`
	Problems []string `json:"problems"`
}

type heartbeatResponse struct {
	Status   *Status `json:"status"`
	Settings struct {
		Enforce     *bool `json:"enforce"`
		StrictHooks *bool `json:"strict_hooks"`
	} `json:"settings"`
}

type loginLinkResponse struct {
	Code      string `json:"code"`
	ExpiresAt string `json:"expires_at"`
}
