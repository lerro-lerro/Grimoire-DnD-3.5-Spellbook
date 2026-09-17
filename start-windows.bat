@echo off
rem Starts Grimoire on Windows in the background: double-click this file.
rem The window closes by itself once the server answers; stop it with stop-windows.bat.
rem From a terminal: start-windows.bat --network   (options go to server.py)
rem It uses Python 3.9+ with lxml. If lxml is missing, it is installed once in a private folder (.venv).
setlocal
cd /d "%~dp0"

rem 1. the private folder made by an earlier start
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -c "import lxml" >nul 2>&1
  if not errorlevel 1 (
    set "PYTHON=.venv\Scripts\python.exe"
    goto run
  )
)

rem 2. Python 3.9 or newer installed on this computer
set "BASE="
py -3 -c "import sys; sys.exit(sys.version_info < (3, 9))" >nul 2>&1 && set "BASE=py -3"
if not defined BASE python -c "import sys; sys.exit(sys.version_info < (3, 9))" >nul 2>&1 && set "BASE=python"
if not defined BASE goto nopython

%BASE% -c "import lxml" >nul 2>&1
if not errorlevel 1 (
  set "PYTHON=%BASE%"
  goto run
)

rem 3. first start: lxml goes into .venv
echo First start: installing lxml in .venv (needs the internet)...
%BASE% -m venv .venv
if errorlevel 1 goto novenv
".venv\Scripts\python.exe" -m pip install --quiet --disable-pip-version-check -r requirements.txt
if errorlevel 1 goto nopip
set "PYTHON=.venv\Scripts\python.exe"

:run
rem the server runs on its own without a window (pythonw); this returns once it answers
%PYTHON% -B server.py --start %*
if errorlevel 1 (
  echo.
  echo Grimoire did not start.
  pause
  exit /b 1
)
exit /b 0

:nopython
echo Grimoire needs Python 3.9 or newer.
echo Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH") and start again.
pause
exit /b 1

:novenv
echo Could not create the .venv folder.
pause
exit /b 1

:nopip
echo Could not install lxml: check the internet connection and try again.
pause
exit /b 1
