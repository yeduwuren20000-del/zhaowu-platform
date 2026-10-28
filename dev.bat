@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有检测到 Node.js，请先安装 Node.js 18 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)

echo 开发模式：后端 http://127.0.0.1:8787  +  前端 http://localhost:5180
echo 按 Ctrl+C 退出
echo.

node "scripts\dev.mjs"
pause
endlocal
