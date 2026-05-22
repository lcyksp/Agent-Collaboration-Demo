@echo off
setlocal
cd /d "%~dp0"

echo [FRONTEND] Working directory: %cd%

if not exist node_modules (
  echo [FRONTEND] Installing Node dependencies...
  npm install
  if errorlevel 1 goto :fail
) else (
  echo [FRONTEND] node_modules already exists, skipping install.
)

echo [FRONTEND] Starting Next.js on http://127.0.0.1:3000
npm run dev
if errorlevel 1 goto :fail

goto :eof

:fail
echo.
echo [FRONTEND][ERROR] Startup failed. Please read the message above.
pause
exit /b 1
