#!/bin/bash
# Starts Grimoire on macOS in the background: double-click this file (the first time: right-click > Open).
# The Terminal window closes by itself once the server answers; stop it with stop-mac.command.
# From the Terminal: ./start-mac.command --network   (options go to server.py)
# It uses Python 3.9+ with lxml. If lxml is missing, it is installed once in a private folder (.venv).
cd "$(dirname "$0")" || exit 1

fail() {
  echo
  echo "$1"
  read -r -p "Press Enter to close this window."
  exit 1
}

# A double-clicked .command runs in a new Terminal window, which stays open when the script ends: close it
# once its shell has finished. A script typed in a Terminal window that was already open leaves it alone.
close_window_later() {
  [ "$TERM_PROGRAM" = "Apple_Terminal" ] || return 0
  local tty_name window
  tty_name=$(tty 2>/dev/null) || return 0
  window=$(osascript -e "tell application \"Terminal\"
    repeat with w in windows
      if tty of selected tab of w is \"$tty_name\" then return id of w
    end repeat
  end tell" 2>/dev/null)
  [ -n "$window" ] || return 0
  trap '' HUP  # the helper must survive the window's shell, which ends right after this script
  nohup /bin/bash -c '
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      if ! kill -0 "$1" 2>/dev/null; then
        osascript -e "tell application \"Terminal\" to close (every window whose id is $2)"
        exit 0
      fi
      sleep 0.25
    done' close-window "$PPID" "$window" >/dev/null 2>&1 &
}

newer_python() {
  for candidate in python3 /usr/local/bin/python3 /opt/homebrew/bin/python3; do
    if command -v "$candidate" >/dev/null 2>&1 &&
       "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 9))' >/dev/null 2>&1; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

if [ -x .venv/bin/python ] && .venv/bin/python -c 'import lxml' >/dev/null 2>&1; then
  PYTHON=.venv/bin/python
else
  PYTHON=$(newer_python) ||
    fail "Grimoire needs Python 3.9 or newer: install it from https://www.python.org/downloads/ (or with: brew install python)."
  if ! "$PYTHON" -c 'import lxml' >/dev/null 2>&1; then
    echo "First start: installing lxml in .venv (needs the internet)…"
    "$PYTHON" -m venv .venv || fail "Could not create the .venv folder."
    .venv/bin/python -m pip install --quiet --disable-pip-version-check -r requirements.txt ||
      fail "Could not install lxml: check the internet connection and try again."
    PYTHON=.venv/bin/python
  fi
fi

# Python from python.org needs its certificates installed once to download from https sites
if ! "$PYTHON" -c 'import ssl, sys; p = ssl.get_default_verify_paths(); sys.exit(not (p.cafile or p.capath))' >/dev/null 2>&1; then
  VERSION=$("$PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])')
  INSTALLER="/Applications/Python $VERSION/Install Certificates.command"
  if [ -x "$INSTALLER" ]; then
    echo "Installing the certificates Python needs for https…"
    "$INSTALLER"
  else
    echo "Warning: Python has no certificates for https, so downloads from dndtools may fail."
  fi
fi

# the server keeps running on its own (also when this window is closed); this returns once it answers
"$PYTHON" -B server.py --start "$@" || fail "Grimoire did not start (see above)."
close_window_later
