@echo off
cd /d "%~dp0"
set PORT=3210
set PERSONA_DATA_DIR=%~dp0data
call npm.cmd run dev
pause
