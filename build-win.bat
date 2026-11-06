@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  if exist "%~dp0.runtime\node\node.exe" (
    rem Portable Node must also be on PATH for npm/npx and install scripts.
    set "PATH=%~dp0.runtime\node;%PATH%"
  ) else (
    echo.
    echo Node.js not found. Run build.bat first (it downloads a portable Node.js),
    echo or install Node.js 22.18+ from https://nodejs.org/ and run this file again.
    echo.
    pause
    exit /b 1
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-win.ps1" %*
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo Build FAILED. See the messages above.
  pause
  exit /b %CODE%
)

echo.
echo Build finished. See the release folder.
pause
exit /b 0
