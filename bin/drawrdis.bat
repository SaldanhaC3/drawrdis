@echo off
rem Drawrdis launcher (Windows). Works from any install location.
setlocal EnableDelayedExpansion
set "APP=%~dp0.."
set "PORTFILE=%APP%\.drawrdis-port"

start "Drawrdis server" /min cmd /c "node "%APP%\server.js""
rem espera o servidor gravar a porta real (ele escala se 3750 estiver ocupada)
set "PORT=3750"
for /l %%i in (1,1,10) do if not exist "%PORTFILE%" timeout /t 1 /nobreak >nul
if exist "%PORTFILE%" set /p PORT=<"%PORTFILE%"
start "" http://127.0.0.1:!PORT!
