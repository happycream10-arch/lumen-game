@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo Node.js 24 LTS is required. Install it from https://nodejs.org/
 pause
 exit /b 1
)
echo Open http://localhost:3000 after the server starts.
node standalone/server.mjs
pause
