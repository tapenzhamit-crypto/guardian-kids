@echo off
title AeroPTT Server
cls
cd /d "%~dp0"
if exist "AeroPTT_Server.exe" (
    AeroPTT_Server.exe
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File server.ps1
)
pause
