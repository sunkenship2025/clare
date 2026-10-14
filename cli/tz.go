package main

import (
	"os"
	"runtime"
	"strings"
	"sync"
)

var (
	tzOnce sync.Once
	tzName string
)

// ianaTimezone returns the machine's IANA zone (e.g. "Asia/Kolkata") so the server
// can say "resets on Monday at 9:30 PM" in local time. Falls back to "UTC".
func ianaTimezone() string {
	tzOnce.Do(func() { tzName = detectTimezone(runtime.GOOS) })
	return tzName
}

func detectTimezone(goos string) string {
	if tz := strings.TrimPrefix(os.Getenv("TZ"), ":"); tz != "" && strings.Contains(tz, "/") {
		return tz
	}
	if goos == "windows" {
		name := strings.TrimSpace(runQuiet("tzutil", "/g"))
		name = strings.TrimSuffix(name, "_dstoff")
		if iana, ok := windowsZones[name]; ok {
			return iana
		}
		return "UTC"
	}
	// macOS and most Linux: /etc/localtime -> /usr/share/zoneinfo/Asia/Kolkata
	if target, err := os.Readlink("/etc/localtime"); err == nil {
		if i := strings.Index(target, "zoneinfo/"); i >= 0 {
			return target[i+len("zoneinfo/"):]
		}
	}
	if b, err := os.ReadFile("/etc/timezone"); err == nil {
		if s := strings.TrimSpace(string(b)); s != "" {
			return s
		}
	}
	return "UTC"
}

// windowsZones maps the most common Windows zone names to IANA names.
var windowsZones = map[string]string{
	"India Standard Time":            "Asia/Kolkata",
	"Pacific Standard Time":          "America/Los_Angeles",
	"Mountain Standard Time":         "America/Denver",
	"US Mountain Standard Time":      "America/Phoenix",
	"Central Standard Time":          "America/Chicago",
	"Eastern Standard Time":          "America/New_York",
	"Atlantic Standard Time":         "America/Halifax",
	"Alaskan Standard Time":          "America/Anchorage",
	"Hawaiian Standard Time":         "Pacific/Honolulu",
	"E. South America Standard Time": "America/Sao_Paulo",
	"GMT Standard Time":              "Europe/London",
	"W. Europe Standard Time":        "Europe/Berlin",
	"Romance Standard Time":          "Europe/Paris",
	"Central European Standard Time": "Europe/Warsaw",
	"Central Europe Standard Time":   "Europe/Budapest",
	"E. Europe Standard Time":        "Europe/Chisinau",
	"FLE Standard Time":              "Europe/Kiev",
	"Russian Standard Time":          "Europe/Moscow",
	"Arabian Standard Time":          "Asia/Dubai",
	"Pakistan Standard Time":         "Asia/Karachi",
	"Bangladesh Standard Time":       "Asia/Dhaka",
	"SE Asia Standard Time":          "Asia/Bangkok",
	"Singapore Standard Time":        "Asia/Singapore",
	"China Standard Time":            "Asia/Shanghai",
	"Tokyo Standard Time":            "Asia/Tokyo",
	"Korea Standard Time":            "Asia/Seoul",
	"AUS Eastern Standard Time":      "Australia/Sydney",
	"New Zealand Standard Time":      "Pacific/Auckland",
	"South Africa Standard Time":     "Africa/Johannesburg",
	"UTC":                            "UTC",
}
