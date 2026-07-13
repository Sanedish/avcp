@echo off
rem ============================================================================
rem AVCP relay - Windows launcher.
rem
rem   double-click start.cmd     relay reachable from THIS PC only (127.0.0.1)
rem   start.cmd lan              also reachable from other devices on your
rem                              network (phone on the same Wi-Fi - no cloud)
rem
rem Needs Node.js 18+ (winget install OpenJS.NodeJS.LTS). Ctrl+C or closing
rem this window stops the relay; nothing is installed as a service. PORT is
rem overridable via the environment. Full reference: README.md.
rem ============================================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found.
  echo Install it first:   winget install OpenJS.NodeJS.LTS
  echo or download it from https://nodejs.org - then run this again.
  pause
  exit /b 1
)
for /f "tokens=1 delims=v." %%v in ('node -v') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 18 (
  echo Your Node.js is too old - version 18 or newer is needed.
  pause
  exit /b 1
)

if not exist node_modules (
  echo installing dependencies...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 ( pause & exit /b 1 )
)

if not defined PORT set PORT=8977
set BIND=127.0.0.1
if /i "%~1"=="lan" set BIND=0.0.0.0

echo.
echo AVCP relay starting on %BIND%:%PORT%   (Ctrl+C or close this window to stop)
echo   panel host side : Settings - Remote Access - Relay server = ws://127.0.0.1:%PORT%
if "%BIND%"=="0.0.0.0" goto :lan

echo   local client    : http://127.0.0.1:%PORT%/?remote=1
echo   (this PC only - run "start.cmd lan" to let your phone on the same Wi-Fi in)
goto :run

:lan
set LANIP=
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-NetIPConfiguration | Where-Object {$_.IPv4DefaultGateway} | Select-Object -First 1).IPv4Address.IPAddress"`) do set LANIP=%%i
if not defined LANIP set LANIP=this-PCs-IP
echo   phone / client  : http://%LANIP%:%PORT%/?remote=1
echo   (?remote=1 marks the device as the remote one - needed on plain http)
echo.
echo   If the phone can't reach this PC, allow the port through Windows
echo   Firewall once - run this in an ADMIN PowerShell:
echo     New-NetFirewallRule -DisplayName "AVCP relay" -Direction Inbound -Protocol TCP -LocalPort %PORT% -Action Allow

:run
echo.
node relay.js
if errorlevel 1 pause
endlocal
