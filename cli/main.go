// clare — one view of your Claude usage across all your computers and browsers,
// with a weekly budget enforced in Claude Code.
//
// One static binary that does everything on an enrolled computer:
//
//	clare enroll <code>   add this computer to clare (run by install.sh with sudo)
//	clare status          this week's usage, your budget, and this device
//	clare dashboard       open the web dashboard, already signed in
//	clare doctor          check (and, with sudo, repair) the install
//	clare uninstall       remove clare from this computer
//	clare hook <event>    called by Claude Code through managed settings
//	clare statusline      Claude Code's managed status line (reads the official meter)
//	clare watchdog        called every 5 minutes by launchd/systemd/schtasks
package main

import (
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"runtime"
	"time"
)

// Set at build time with -ldflags "-X main.version=... -X main.defaultAPI=... -X main.defaultWeb=...".
var (
	version    = "dev"
	defaultAPI = ""
	defaultWeb = ""
)

// App holds everything that differs between a real run and a test run,
// so commands never reach for globals directly.
type App struct {
	GOOS      string
	SysDir    string // system dir that holds managed settings (root-owned)
	StateDir  string // per-user cache dir (offsets, queue, cached status)
	NoService bool   // skip launchd/systemd/schtasks and the /usr/local/bin symlink
	TestMode  bool   // CLARE_SYSTEM_DIR is set: skip the root check
	Now       func() time.Time
	HTTP      *http.Client
	In        io.Reader
	Out       io.Writer
	Err       io.Writer

	// Browser guide. Tests set these; real runs detect browsers, read the terminal, and
	// use the extension bundled into the binary.
	TTY      io.Reader
	Browsers func() []foundBrowser
	ExtFS    fs.FS
	opened   []string // test mode: what would have been opened or copied
}

func newApp() *App {
	a := &App{
		GOOS:      runtime.GOOS,
		SysDir:    os.Getenv("CLARE_SYSTEM_DIR"),
		StateDir:  os.Getenv("CLARE_STATE_DIR"),
		NoService: os.Getenv("CLARE_NO_SERVICE") == "1",
		Now:       time.Now,
		HTTP:      &http.Client{},
		In:        os.Stdin,
		Out:       os.Stdout,
		Err:       os.Stderr,
	}
	if a.SysDir == "" {
		a.SysDir = defaultSystemDir(a.GOOS)
	} else {
		a.TestMode = true
	}
	if a.StateDir == "" {
		a.StateDir = defaultStateDir(a.GOOS)
	}
	return a
}

func main() {
	os.Exit(newApp().run(os.Args[1:]))
}

func (a *App) run(args []string) (code int) {
	cmd := ""
	if len(args) > 0 {
		cmd = args[0]
	}

	defer func() {
		if r := recover(); r != nil {
			// Hooks, the status line and the watchdog must never break Claude Code: stay silent and allow.
			if cmd == "hook" || cmd == "statusline" || cmd == "watchdog" {
				code = 0
				return
			}
			u := newUI(a.Err)
			u.blank()
			u.fail("Something went wrong inside clare.")
			u.line("    Please try again. If it keeps happening, run:  sudo clare doctor")
			u.blank()
			code = 1
		}
	}()

	switch cmd {
	case "", "help", "-h", "--help":
		a.printHelp()
		return 0
	case "version", "-v", "--version":
		fmt.Fprintf(a.Out, "clare %s\n", version)
		return 0
	case "enroll":
		return a.runEnroll(args[1:])
	case "status":
		return a.runStatus()
	case "dashboard", "dash", "open":
		return a.runDashboard()
	case "profile", "profiles":
		return a.runProfile(args[1:])
	case "browser", "browsers", "extension":
		return a.runBrowser()
	case "doctor":
		return a.runDoctor()
	case "uninstall":
		return a.runUninstall(args[1:])
	case "hook":
		event := ""
		if len(args) > 1 {
			event = args[1]
		}
		return a.runHook(event)
	case "statusline":
		return a.runStatusLine()
	case "watchdog":
		return a.runWatchdog()
	default:
		u := newUI(a.Err)
		u.blank()
		u.fail(fmt.Sprintf("clare doesn't know the command %q.", cmd))
		u.blank()
		a.printHelp()
		return 1
	}
}

func (a *App) printHelp() {
	u := newUI(a.Out)
	u.blank()
	u.line("  %s — your Claude usage across all your devices, with a weekly budget.", u.bold("clare"))
	u.blank()
	u.line("  %s       This week's usage, your budget, and this device", u.cyan("clare status"))
	u.line("  %s    Open the clare dashboard in your browser", u.cyan("clare dashboard"))
	u.line("  %s      Add clare's extension to a browser on this computer, step by step", u.cyan("clare browser"))
	u.line("  %s      Which Claude Code profiles clare covers (sudo clare profile NAME to limit it)", u.cyan("clare profile"))
	u.line("  %s       Check this computer's setup (add sudo to repair it)", u.cyan("clare doctor"))
	u.line("  %s    Remove clare from this computer (needs sudo)", u.cyan("clare uninstall"))
	u.line("  %s      Show the version", u.cyan("clare version"))
	u.blank()
	u.line("  %s", u.dim("To add a computer, open your clare dashboard and choose \"Add a device\"."))
	u.blank()
}
