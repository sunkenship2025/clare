package main

import (
	"fmt"
	"io"
	"math"
	"os"
	"strings"
	"time"
)

// ui prints short, friendly terminal output. Colors only on a real terminal.
type ui struct {
	w     io.Writer
	color bool
}

func newUI(w io.Writer) *ui {
	color := false
	if f, ok := w.(*os.File); ok && os.Getenv("NO_COLOR") == "" && os.Getenv("TERM") != "dumb" {
		if st, err := f.Stat(); err == nil && st.Mode()&os.ModeCharDevice != 0 {
			color = true
		}
	}
	return &ui{w: w, color: color}
}

func (u *ui) paint(code, s string) string {
	if !u.color {
		return s
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}

func (u *ui) bold(s string) string   { return u.paint("1", s) }
func (u *ui) dim(s string) string    { return u.paint("2", s) }
func (u *ui) red(s string) string    { return u.paint("31", s) }
func (u *ui) green(s string) string  { return u.paint("32", s) }
func (u *ui) yellow(s string) string { return u.paint("33", s) }
func (u *ui) cyan(s string) string   { return u.paint("36", s) }

func (u *ui) line(format string, args ...any) { fmt.Fprintf(u.w, format+"\n", args...) }
func (u *ui) blank()                          { fmt.Fprintln(u.w) }
func (u *ui) ok(msg string)                   { u.line("  %s %s", u.green("✓"), msg) }
func (u *ui) warn(msg string)                 { u.line("  %s %s", u.yellow("!"), msg) }
func (u *ui) fail(msg string)                 { u.line("  %s %s", u.red("✗"), msg) }

// bar renders a text progress bar, e.g. ███████░░░░░░░░░░░░░.
func bar(pct float64, width int) string {
	p := math.Max(0, math.Min(100, pct))
	filled := int(math.Round(p / 100 * float64(width)))
	return strings.Repeat("█", filled) + strings.Repeat("░", width-filled)
}

// friendlyTime: "today at 9:30 PM", "tomorrow at 9:30 PM", "Monday at 9:30 PM", "Oct 30 at 9:30 PM".
func friendlyTime(t, now time.Time) string {
	t = t.Local()
	now = now.Local()
	clock := t.Format("3:04 PM")
	day := func(x time.Time) time.Time { return time.Date(x.Year(), x.Month(), x.Day(), 0, 0, 0, 0, time.Local) }
	days := int(math.Round(day(t).Sub(day(now)).Hours() / 24))
	switch {
	case days == 0:
		return "today at " + clock
	case days == 1:
		return "tomorrow at " + clock
	case days > 1 && days < 7:
		return t.Format("Monday") + " at " + clock
	default:
		return t.Format("Jan 2") + " at " + clock
	}
}

// ago: "just now", "5 minutes ago", "3 hours ago", "2 days ago".
func ago(d time.Duration) string {
	switch {
	case d < time.Minute:
		return "just now"
	case d < 2*time.Minute:
		return "a minute ago"
	case d < time.Hour:
		return fmt.Sprintf("%d minutes ago", int(d.Minutes()))
	case d < 2*time.Hour:
		return "an hour ago"
	case d < 48*time.Hour:
		return fmt.Sprintf("%d hours ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%d days ago", int(d.Hours()/24))
	}
}
