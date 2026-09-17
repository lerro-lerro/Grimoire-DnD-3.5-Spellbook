@echo off
rem Stops the Grimoire started by start-windows.bat: double-click this file.
rem If it was started with --data <folder>, stop it from a terminal with the same option.
setlocal
cd /d "%~dp0"

set "PYTHON="
if exist ".venv\Scripts\python.exe" set "PYTHON=.venv\Scripts\python.exe"
if not defined PYTHON py -3 -c "" >nul 2>&1 && set "PYTHON=py -3"
if not defined PYTHON python -c "" >nul 2>&1 && set "PYTHON=python"
if not defined PYTHON (
  echo Python was not found, so Grimoire can't be running from this folder.
  pause
  exit /b 1
)

%PYTHON% -B server.py --stop %*
if errorlevel 1 (
  pause
  exit /b 1
)
rem a moment to read the message
timeout /t 2 /nobreak >nul
exit /b 0
