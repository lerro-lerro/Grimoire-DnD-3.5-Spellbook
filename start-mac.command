#!/bin/bash
# Starts Grimoire on macOS: double-click this file (the first time: right-click > Open).
# From the Terminal: ./start-mac.command --network   (options go to server.py)
# It uses Python 3.9+ with lxml. If lxml is missing, it is installed once in a private folder (.venv).
cd "$(dirname "$0")" || exit 1

fail() {
  echo
  echo "$1"
  read -r -p "Press Enter to close this window."
  exit 1
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

"$PYTHON" -B server.py "$@" || fail "Grimoire stopped with an error (see above)."
