@echo off
rem Compatibility entry: delegate to build.bat, which downloads missing
rem Node.js, npm dependencies and the Pokemon Showdown engine source.
call "%~dp0build.bat" %*
exit /b %ERRORLEVEL%
