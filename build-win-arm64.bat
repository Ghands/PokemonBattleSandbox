@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js not found. Install Node.js 22.18+ from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-win.ps1" -Arch arm64 %*
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo Build FAILED. See the messages above.
  pause
  exit /b %CODE%
)

echo.
echo Build finished. See the release folder (win-arm64-unpacked / *-arm64.exe).
pause
exit /b 0
