@echo off
setlocal
cd /d "%~dp0"

set "PORT=8001"

echo [BACKEND] Working directory: %cd%

if not exist .venv (
  echo [BACKEND] Creating virtual environment...
  python -m venv .venv
  if errorlevel 1 goto :fail
)

call .venv\Scripts\activate.bat
if errorlevel 1 goto :fail

if not exist .env (
  echo [BACKEND] Creating .env from template...
  copy /y .env.example .env >nul
  if errorlevel 1 goto :fail
)

echo [BACKEND] Installing Python dependencies if needed...
python -m pip install -r requirements.txt
if errorlevel 1 goto :fail

echo [BACKEND] Starting uvicorn on http://127.0.0.1:%PORT%
uvicorn app.main:app --host 127.0.0.1 --port %PORT% --reload
if errorlevel 1 goto :fail

goto :eof

:fail
echo.
echo [BACKEND][ERROR] Startup failed. Please read the message above.
pause
exit /b 1
