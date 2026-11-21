@echo off
rem ---------------------------------------------------------------------------
rem  Sylk - build and install from source.
rem  Double-click this file. It checks the toolchain, compiles, packages,
rem  installs to your user profile and puts a shortcut on the desktop.
rem
rem  Command line:
rem    build.cmd              build + install
rem    build.cmd --dist       build only, leave the installer for sharing
rem    build.cmd --check      check the toolchain, change nothing
rem ---------------------------------------------------------------------------
chcp 65001 >nul 2>nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto no_node

call npm run setup -- %*
if errorlevel 1 goto failed

echo.
pause
exit /b 0

:no_node
echo.
echo   Node.js 20 or newer is required, but "node" was not found.
echo   Download the LTS build from https://nodejs.org/ then run this file again.
echo.
pause
exit /b 1

:failed
echo.
echo   Build did not finish. Read the message above for what is missing.
echo.
pause
exit /b 1
