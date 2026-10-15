#!/bin/sh
# clare installer — connects Claude Code on this computer to clare.
#
#   curl -fsSL __CLARE_WEB_URL__/install.sh | sh -s -- <enrollment-code> [--label NAME] [--profile NAME]
#
# Downloads one small program (clare), then asks for your password once (sudo) so it can
# install Claude Code managed settings for every terminal, editor and the desktop app.
#
# For testing: CLARE_BINARY=/path/to/clare skips the download;
# CLARE_API_URL / CLARE_WEB_URL / CLARE_RELEASES_URL override the built-in addresses.
set -eu

CODE="${1:-${CLARE_CODE:-}}"
[ $# -gt 0 ] && shift
EXTRA="$*" # passed on to clare enroll, e.g. --label joy --profile pranav
API="${CLARE_API_URL:-__CLARE_API_URL__}"
WEB="${CLARE_WEB_URL:-__CLARE_WEB_URL__}"
RELEASES="${CLARE_RELEASES_URL:-__CLARE_RELEASES_URL__}"

say() { printf '%s\n' "$*"; }
fail() {
  printf '\n  %s\n\n' "$*" >&2
  exit 1
}

say ""
[ -n "$CODE" ] || fail "The enrollment code is missing. In your clare dashboard choose Add a device, open the link, and copy the command from there."
case "$API" in
  *__CLARE_*) fail "This installer has no server address yet. Build it with scripts/build.mjs (or set CLARE_API_URL)." ;;
esac
case "$WEB" in *__CLARE_*) WEB="" ;; esac

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "This installer is for Mac and Linux. On Windows, use the PowerShell command from the enrollment page." ;;
esac
case "$arch" in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "Sorry, this kind of computer ($arch) isn't supported yet." ;;
esac

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t clare)
trap 'rm -rf "$tmp"' EXIT INT TERM
bin="$tmp/clare"

if [ -n "${CLARE_BINARY:-}" ]; then
  cp "$CLARE_BINARY" "$bin"
else
  case "$RELEASES" in
    *__CLARE_*) fail "This installer has no download address yet. Build it with scripts/build.mjs (or set CLARE_RELEASES_URL)." ;;
  esac
  url="$RELEASES/clare-$os-$arch"
  say "  Downloading clare…"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$bin" || fail "Couldn't download clare. Check your internet connection and try again."
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$bin" "$url" || fail "Couldn't download clare. Check your internet connection and try again."
  else
    fail "This computer needs curl or wget to install clare."
  fi
fi
chmod +x "$bin"

# After enrolling, clare walks through adding its extension to each browser on this computer.
set -- enroll "$CODE" --api "$API"
[ -n "$WEB" ] && set -- "$@" --web "$WEB"
# shellcheck disable=SC2086
[ -n "$EXTRA" ] && set -- "$@" $EXTRA

if [ "$(id -u)" -eq 0 ]; then
  "$bin" "$@"
  exit $?
fi

say ""
say "  clare needs your password once (sudo) to install Claude Code managed settings."
say "  (Nothing shows on screen while you type it. That's normal.)"
say ""

# When piped from curl, stdin is this script; give sudo and clare the real keyboard.
if [ -r /dev/tty ] && (: </dev/tty) 2>/dev/null; then
  sudo "$bin" "$@" </dev/tty
else
  sudo "$bin" "$@"
fi
