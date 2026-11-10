@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\run.ps1" start %*
set "fundamental_exit=%errorlevel%"
if not "%fundamental_exit%"=="0" echo The operation needs attention. Read the message above.
pause
exit /b %fundamental_exit%
