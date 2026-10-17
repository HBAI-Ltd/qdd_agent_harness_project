@echo off
setlocal
node "%~dp0apps\android-mcp\tools\start.mjs" %*
exit /b %errorlevel%
