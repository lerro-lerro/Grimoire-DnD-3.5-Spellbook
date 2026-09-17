#!/usr/bin/env bash
# Starts Grimoire on Linux in the background, without a window:  ./start-linux.sh   (stop it with ./stop-linux.sh)
# Options go to server.py, e.g. ./start-linux.sh --network
# ./start-linux.sh --add-to-menu adds "Grimoire" and "Stop Grimoire" to the applications menu (no terminal at all).
# It uses Python 3.9+ with lxml. If lxml is missing, it is installed once in a private folder (.venv).
cd "$(dirname "$0")" || exit 1

# in the terminal, or as a desktop notification when started from the menu
say() {
  if [ -t 1 ] || ! command -v notify-send >/dev/null 2>&1; then
    echo "$1"
  else
    notify-send --app-name=Grimoire "Grimoire" "$1"
  fi
}

if [ "$1" = "--add-to-menu" ]; then
  apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$apps" || exit 1
  desktop_value() { printf '%s' "$1" | sed 's/\\/\\\\/g'; }
  desktop_exec() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/[\\"`$]/\\\\&/g' -e 's/%/%%/g')"; }
  menu_entry() {  # file name, title, script, description
    cat > "$apps/$1" <<EOF
[Desktop Entry]
Type=Application
Name=$2
Comment=$4
Exec=$(desktop_exec "$PWD/$3")
Path=$(desktop_value "$PWD")
Icon=$(desktop_value "$PWD/web/icon-192.png")
Terminal=false
Categories=Game;
EOF
  }
  menu_entry grimoire.desktop "Grimoire" start-linux.sh "Open your D&D 3.5 spellbooks" &&
    menu_entry grimoire-stop.desktop "Stop Grimoire" stop-linux.sh "Stop the Grimoire server" || exit 1
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$apps" >/dev/null 2>&1
  echo "Added \"Grimoire\" and \"Stop Grimoire\" to the applications menu."
  echo "If you move this folder, run ./start-linux.sh --add-to-menu again."
  exit 0
fi

newer_python() {
  for candidate in python3 python; do
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
elif PYTHON=$(newer_python) && "$PYTHON" -c 'import lxml' >/dev/null 2>&1; then
  :
elif [ -n "$PYTHON" ]; then
  say "First start: installing lxml in .venv (needs the internet, it takes a minute)…"
  if ! "$PYTHON" -m venv .venv >/dev/null 2>&1; then
    say "Could not create .venv. Install lxml with your package manager instead (e.g. sudo apt install python3-lxml, sudo dnf install python3-lxml) and start again."
    exit 1
  fi
  if ! .venv/bin/python -m pip install --quiet --disable-pip-version-check -r requirements.txt; then
    say "Could not install lxml: check the internet connection and start again."
    exit 1
  fi
  PYTHON=.venv/bin/python
else
  say "Grimoire needs Python 3.9 or newer: install it with your package manager (e.g. sudo apt install python3 python3-venv) and start again."
  exit 1
fi

# the server keeps running on its own (also when this terminal is closed); this returns once it answers
output=$("$PYTHON" -B server.py --start "$@" 2>&1)
status=$?
if [ $status -ne 0 ] || [ -t 1 ]; then
  say "$output"
fi
exit $status
