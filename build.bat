@echo off
rem =====================================================================
rem  Pokemon Battle Sim - clean build kit entry point (Windows)
rem
rem  This folder ships NO Node.js, NO node_modules and NO Pokemon Showdown
rem  source. When needed this script downloads a portable Node.js, then
rem  bootstrap.cjs downloads npm dependencies and the engine source, and
rem  finally produces the installers.
rem
rem  Usage: build.bat --os windows --arch x64
rem         build.bat --os all --arch all
rem         build.bat --setup-only
rem =====================================================================
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion
cd /d "%~dp0"
set "KIT=%~dp0"

set "VER=22.22.2"
if exist "%KIT%.node-version" (
  for /f "usebackq delims=" %%v in ("%KIT%.node-version") do set "VER=%%v"
)
if defined PBSIM_NODE_VERSION set "VER=%PBSIM_NODE_VERSION%"

set "NARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "NARCH=arm64"

rem 1) explicit PBSIM_NODE  2) downloaded portable Node  3) node on PATH
set "NODE_EXE="
if defined PBSIM_NODE if exist "%PBSIM_NODE%" set "NODE_EXE=%PBSIM_NODE%"
if not defined NODE_EXE if exist "%KIT%.runtime\node\node.exe" set "NODE_EXE=%KIT%.runtime\node\node.exe"
if not defined NODE_EXE if not "%PBSIM_FORCE_NODE%"=="1" goto :findsystem
goto :check

:findsystem
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"

:check
if defined NODE_EXE goto :run
call :download
if errorlevel 1 exit /b 1

:run
echo [kit] Node: "%NODE_EXE%"
"%NODE_EXE%" "%KIT%bootstrap.cjs" %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo [kit] Build FAILED ^(exit %CODE%^). See messages above.
  exit /b %CODE%
)
echo.
echo [kit] Build finished. Artifacts are in release\ ^(or --out dir^).
exit /b 0

rem ---------------------------------------------------------------------
:download
echo [kit] Node.js not found - downloading portable Node v%VER% ^(%NARCH%^) ...
if not exist "%KIT%.runtime" mkdir "%KIT%.runtime"
set "ZIP=%KIT%.runtime\node-download.zip"
set "NAME=node-v%VER%-win-%NARCH%.zip"
set "URL=https://npmmirror.com/mirrors/node/v%VER%/%NAME%"
set "CURL=%SystemRoot%\System32\curl.exe"

if not exist "%CURL%" (
  echo [kit] ERROR: curl.exe not found. Install Node.js 22.18+ manually or set PBSIM_NODE.
  exit /b 1
)
"%CURL%" -fsSL --retry 3 --connect-timeout 20 -o "%ZIP%" "%URL%"
if errorlevel 1 (
  echo [kit] mirror failed, trying nodejs.org ...
  "%CURL%" -fsSL --retry 3 --connect-timeout 20 -o "%ZIP%" "https://nodejs.org/dist/v%VER%/%NAME%"
)
if errorlevel 1 (
  echo [kit] ERROR: cannot download Node.js. Check the network, or set PBSIM_NODE.
  exit /b 1
)

"%SystemRoot%\System32\tar.exe" -xf "%ZIP%" -C "%KIT%.runtime"
if errorlevel 1 (
  echo [kit] tar.exe extraction failed, trying PowerShell Expand-Archive ...
  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "Expand-Archive -Force -Path '%ZIP%' -DestinationPath '%KIT%.runtime'"
)
if not exist "%KIT%.runtime\node-v%VER%-win-%NARCH%\node.exe" (
  echo [kit] ERROR: unexpected Node.js archive layout.
  exit /b 1
)
if exist "%KIT%.runtime\node" rmdir /s /q "%KIT%.runtime\node"
move /y "%KIT%.runtime\node-v%VER%-win-%NARCH%" "%KIT%.runtime\node" >nul
if errorlevel 1 (
  echo [kit] ERROR: cannot move portable Node into place.
  exit /b 1
)
del /q "%ZIP%" >nul 2>&1
set "NODE_EXE=%KIT%.runtime\node\node.exe"
echo [kit] portable Node ready: "%NODE_EXE%"
exit /b 0
