@echo off
chcp 65001 >nul
cd /d "%~dp0"
uv run main.py --host 0.0.0.0 %*
pause
