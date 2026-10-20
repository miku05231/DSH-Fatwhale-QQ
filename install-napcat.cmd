@echo off
rem Download and unpack NapCatQQ into .\napcat  (about 118 MB on first run).
rem Already installed?  This exits without touching your existing files.
setlocal
cd /d "%~dp0"

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-napcat.ps1" %*
set "CODE=%ERRORLEVEL%"

echo.
echo [i] After NapCat logs in, enable its WebSocket server on port 3001.
echo.
pause
exit /b %CODE%
