@echo off
title Tether Tool
rem Double-click this file to start Tether Tool on Windows.
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and try again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First start: downloading what the app needs. This takes a minute or two...
  call npm install
  if errorlevel 1 (
    echo.
    echo Something went wrong. Take a screenshot of this window and send it to Claude.
    pause
    exit /b 1
  )
)

echo Starting Tether Tool...
call npm start
if errorlevel 1 (
  echo.
  echo Something went wrong. Take a screenshot of this window and send it to Claude.
  pause
)
