@echo off
rem Installs CCodex from this checkout: double-click it, nothing to type.
title Install CCodex
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set CCODEX_EXIT=%ERRORLEVEL%
echo.
if not "%CCODEX_EXIT%"=="0" (echo CCodex install failed ^(exit code %CCODEX_EXIT%^). Read the messages above.) else (echo CCodex install finished.)
echo Press any key to close this window.
pause >nul
exit /b %CCODEX_EXIT%
