@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem Always run the application with Node.js 22 LTS. The installed system Node.js
rem may be newer; npx downloads/caches the compatible runtime automatically.
where npx >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm/npx was not found. Install Node.js with npm, then run this file again.
  pause
  exit /b 1
)

set "NODE22_VERSION=22.23.2"
echo [MusicForUrl] Preparing Node.js %NODE22_VERSION% LTS runtime...
call npx --yes node@%NODE22_VERSION% -e "if (process.versions.node.split('.')[0] !== '22') process.exit(1)" >nul 2>nul
if errorlevel 1 goto :node22_failed

rem FFmpeg may be installed normally without its bin directory being in PATH.
where ffmpeg >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\ffmpeg\bin\ffmpeg.exe" (
  set "PATH=%ProgramFiles%\ffmpeg\bin;%PATH%"
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo [ERROR] FFmpeg was not found. Install a GPU-enabled FFmpeg build and add it to PATH.
  pause
  exit /b 1
)

rem Locate npm's JavaScript entry point so dependency install scripts also run
rem under Node.js 22 instead of the newer system Node.js.
for /f "delims=" %%I in ('where npm.cmd 2^>nul') do if not defined NPM_DIR set "NPM_DIR=%%~dpI"
set "NPM_CLI_JS=%NPM_DIR%node_modules\npm\bin\npm-cli.js"

if not exist node_modules (
  call :install_dependencies
  if errorlevel 1 goto :failed
) else (
  call npx --yes node@%NODE22_VERSION% -e "const Database=require('better-sqlite3');const db=new Database(':memory:');db.close()" >nul 2>nul
  if errorlevel 1 (
    echo [MusicForUrl] Damaged or incompatible native dependencies detected.
    echo [MusicForUrl] Reinstalling dependencies for Node.js 22 on Windows...
    rmdir /s /q node_modules
    call :install_dependencies
    if errorlevel 1 goto :failed
    call npx --yes node@%NODE22_VERSION% -e "const Database=require('better-sqlite3');const db=new Database(':memory:');db.close()" >nul 2>nul
    if errorlevel 1 goto :native_failed
  )
)

echo [MusicForUrl] Running with Node.js %NODE22_VERSION% LTS.
echo [MusicForUrl] GPU encoder will be detected automatically.
echo [MusicForUrl] Open http://localhost:3000 after startup.
call npx --yes node@%NODE22_VERSION% server.js
exit /b %errorlevel%

:install_dependencies
if not exist "%NPM_CLI_JS%" (
  echo [ERROR] npm-cli.js was not found beside the installed npm command.
  exit /b 1
)
call npx --yes node@%NODE22_VERSION% "%NPM_CLI_JS%" install
exit /b %errorlevel%

:node22_failed
echo [ERROR] Node.js 22 LTS could not be downloaded or started through npx.
echo [ERROR] Check the network connection and npm configuration, then try again.
pause
exit /b 1

:failed
echo [ERROR] Dependency installation failed.
pause
exit /b 1

:native_failed
echo [ERROR] better-sqlite3 could not load with Node.js 22 on Windows.
echo [ERROR] Delete node_modules and run this file again.
pause
exit /b 1
