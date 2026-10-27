@echo off
rem Start the QQ-DSH tray icon (launcher\Launcher.ps1).  Double-click this file.
rem
rem Why a .cmd wrapper: this machine's PowerShell execution policy is Restricted,
rem so Windows refuses to run .ps1 files directly. -ExecutionPolicy Bypass only
rem affects this one process, it does not weaken the machine-wide setting.
setlocal
cd /d "%~dp0"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"
start "" "%PS%" -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0launcher\Launcher.ps1"
timeout /t 2 /nobreak >nul
exit /b 0