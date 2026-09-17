#!/usr/bin/env bash
# Stops the Grimoire started by start-linux.sh:  ./stop-linux.sh
# If it was started with --data <folder>, stop it with the same option.
cd "$(dirname "$0")" || exit 1

say() {
  if [ -t 1 ] || ! command -v notify-send >/dev/null 2>&1; then
    echo "$1"
  else
    notify-send --app-name=Grimoire "Grimoire" "$1"
  fi
}

if [ -x .venv/bin/python ]; then
  PYTHON=.venv/bin/python
elif command -v python3 >/dev/null 2>&1; then
  PYTHON=python3
elif command -v python >/dev/null 2>&1; then
  PYTHON=python
else
  say "Python was not found, so Grimoire can't be running from this folder."
  exit 1
fi

output=$("$PYTHON" -B server.py --stop "$@" 2>&1)
status=$?
say "$output"
exit $status
