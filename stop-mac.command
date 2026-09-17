#!/bin/bash
# Stops the Grimoire started by start-mac.command: double-click this file (the first time: right-click > Open).
# If it was started with --data <folder>, stop it from the Terminal with the same option.
cd "$(dirname "$0")" || exit 1

fail() {
  echo
  echo "$1"
  read -r -p "Press Enter to close this window."
  exit 1
}

# the same as in start-mac.command: the window opened by a double-click closes once its shell has finished
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

if [ -x .venv/bin/python ]; then
  PYTHON=.venv/bin/python
elif command -v python3 >/dev/null 2>&1; then
  PYTHON=python3
else
  fail "Python was not found, so Grimoire can't be running from this folder."
fi

"$PYTHON" -B server.py --stop "$@" || fail "Grimoire could not be stopped (see above)."
sleep 1  # a moment to read the message
close_window_later
