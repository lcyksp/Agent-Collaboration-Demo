@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
set "BACKEND_SCRIPT=%ROOT%backend\run_backend.bat"
set "FRONTEND_SCRIPT=%ROOT%frontend\run_frontend.bat"
set "BACKEND_DIR=%ROOT%backend"
set "FRONTEND_DIR=%ROOT%frontend"
set "BACKEND_PORT=8001"
set "FRONTEND_PORT=3000"

if not exist "%BACKEND_SCRIPT%" (
  echo [ERROR] Missing backend launcher: %BACKEND_SCRIPT%
  pause
  exit /b 1
)
if not exist "%FRONTEND_SCRIPT%" (
  echo [ERROR] Missing frontend launcher: %FRONTEND_SCRIPT%
  pause
  exit /b 1
)

if not exist "%FRONTEND_DIR%\.env.local" (
  > "%FRONTEND_DIR%\.env.local" echo NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:%BACKEND_PORT%
) else (
  powershell -NoProfile -Command "$p='%FRONTEND_DIR%\\.env.local'; $lines = Get-Content $p -ErrorAction SilentlyContinue ^| Where-Object { $_ -notmatch '^NEXT_PUBLIC_API_BASE_URL=' }; Set-Content -Path $p -Value $lines; Add-Content -Path $p -Value 'NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:%BACKEND_PORT%'"
)

echo [INFO] Launching backend and frontend...
start "NexusAgent Backend" cmd /k ""%BACKEND_SCRIPT%""
start "NexusAgent Frontend" cmd /k ""%FRONTEND_SCRIPT%""

echo.
echo [DONE] Windows opened.
echo Backend:  http://127.0.0.1:%BACKEND_PORT%/healthz
echo Frontend: http://127.0.0.1:%FRONTEND_PORT%
endlocal

