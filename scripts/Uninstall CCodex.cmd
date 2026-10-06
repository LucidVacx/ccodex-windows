@echo off
rem Uninstalls CCodex: double-click it, nothing to type. State in %USERPROFILE%\.ccodex\state stays.
title Uninstall CCodex
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
set CCODEX_EXIT=%ERRORLEVEL%
echo.
if not "%CCODEX_EXIT%"=="0" (echo CCodex uninstall failed ^(exit code %CCODEX_EXIT%^). Read the messages above.) else (echo CCodex uninstall finished.)
echo Press any key to close this window.
pause >nul
exit /b %CCODEX_EXIT%
