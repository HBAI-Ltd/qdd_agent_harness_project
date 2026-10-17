@echo off
setlocal
cd /d "%~dp0"
node apps\esp\tools\wifi.mjs %*
if errorlevel 1 pause
