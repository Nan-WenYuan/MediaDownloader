@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Please install Node.js 24.
  pause
  exit /b 1
)
if "%~1"=="--check" (
  node --check src\terminal.mjs
  exit /b
)
node src\terminal.mjs %*
if errorlevel 1 pause
