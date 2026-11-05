@echo off
REM HarmonyOS PC build entry for Windows (DevEco Studio installed).
REM Run "node tools\build-ohos.cjs --help" for the required environment vars.
cd /d "%~dp0"
node tools\build-ohos.cjs %*
