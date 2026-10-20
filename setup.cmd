@echo off
rem One-time environment setup.  Double-click this file (or run it from a
rem terminal).  Safe to run repeatedly: it never overwrites your config.json.
setlocal
cd /d "%~dp0"

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" %*
set "CODE=%ERRORLEVEL%"

echo.
if not "%CODE%"=="0" (
  echo [!] Setup exited with code %CODE%. See the messages above.
) else (
  echo [i] Next: double-click start-tray.cmd to put the tray icon in your taskbar.
)
echo.
pause
exit /b %CODE%
