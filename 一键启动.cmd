@echo off
rem ============================================================
rem  QQ-DSH one-click launcher
rem
rem  1) start NapCat if it is not running (minimized window)
rem  2) start DeepSeek Harness if it is not running
rem  3) start the tray icon (everything else lives in its menu)
rem
rem  Double-clicking twice is safe: nothing is started twice.
rem  To stop everything: tray icon -> right click -> Exit.
rem
rem  NOTE: this file is intentionally ASCII-only. Chinese text
rem  under the default OEM code page turns into garbage here;
rem  all user-facing Chinese output comes from bootstrap.ps1.
rem ============================================================
setlocal
cd /d "%~dp0"

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\bootstrap.ps1"
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo [!] startup failed, exit code %CODE% - see state\launcher.log
  echo.
  pause
)

exit /b %CODE%
