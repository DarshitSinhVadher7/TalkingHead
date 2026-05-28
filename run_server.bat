@echo off
title TalkingHead Local Server
echo ==========================================
echo   Starting Local Server for TalkingHead
echo ==========================================
echo.

:: Check if npx is available and run serve
where npx >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [INFO] Starting server via Node.js/npx...
    echo [INFO] Server will be available at http://localhost:3000
    npx -y serve .
    goto end
)

:: If npx not found, try Python
where python >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [INFO] Node.js not found. Starting server via Python...
    echo [INFO] Server will be available at http://localhost:8000
    echo [INFO] Navigate to http://localhost:8000/examples/mp3.html in your browser.
    python -m http.server 8000
    goto end
)

:: If both fail
echo [ERROR] Neither Node.js (npx) nor Python was found on your system.
echo Please install Node.js or Python to run a local web server.
echo.
pause

:end
