@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "PY=..\upscaler\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

echo ============================================
echo   本地私人影院
echo   片库目录: %~dp0library
echo   正在打开 http://127.0.0.1:8888 ...
echo   关闭本窗口即可停止服务
echo ============================================
start "" http://127.0.0.1:8888
"%PY%" server.py
pause
