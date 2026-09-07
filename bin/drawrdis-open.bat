@echo off
rem Opens a .drawrdis / .json board file: starts the server if needed,
rem loads the file into the board and opens the browser.
setlocal EnableDelayedExpansion
set "APP=%~dp0.."
set "PORTFILE=%APP%\.drawrdis-port"
set "PORT=3750"
if exist "%PORTFILE%" set /p PORT=<"%PORTFILE%"

curl -s -o nul --max-time 2 http://127.0.0.1:!PORT!/scene
if errorlevel 1 (
  start "Drawrdis server" /min cmd /c "node "%APP%\server.js""
  for /l %%i in (1,1,10) do if not exist "%PORTFILE%" timeout /t 1 /nobreak >nul
  if exist "%PORTFILE%" set /p PORT=<"%PORTFILE%"
)

set "SRV=http://127.0.0.1:!PORT!"
curl -s -X POST -H "content-type: application/json" --data-binary "@%~1" !SRV!/open >nul
start "" !SRV!
