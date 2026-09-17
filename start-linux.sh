#!/usr/bin/env bash
# Starts Grimoire on Linux:  ./start-linux.sh   (options go to server.py, e.g. ./start-linux.sh --network)
# It uses Python 3.9+ with lxml. If lxml is missing, it is installed once in a private folder (.venv).
set -e
cd "$(dirname "$0")"

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
  echo "First start: installing lxml in .venv (needs the internet)…"
  if ! "$PYTHON" -m venv .venv; then
    echo "Could not create .venv. Install lxml with your package manager instead"
    echo "(e.g. sudo apt install python3-lxml, sudo dnf install python3-lxml) and start again."
    exit 1
  fi
  if ! .venv/bin/python -m pip install --quiet --disable-pip-version-check -r requirements.txt; then
    echo "Could not install lxml: check the internet connection and start again."
    exit 1
  fi
  PYTHON=.venv/bin/python
else
  echo "Grimoire needs Python 3.9 or newer: install it with your package manager"
  echo "(e.g. sudo apt install python3 python3-venv) and start again."
  exit 1
fi

exec "$PYTHON" -B server.py "$@"
