@echo off
title Guardian Kids Local OTA Server
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\local_ota_server.ps1"
if %errorlevel% neq 0 (
    echo.
    echo Server stopped with error.
    pause
)
