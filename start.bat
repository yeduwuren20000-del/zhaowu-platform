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

echo ================================================================
echo   开发与服务器管理工作台  Dev ^& Server Management Workbench
echo   首次运行会自动安装依赖并构建前端，请耐心等待
echo ================================================================
echo.

node "scripts\start.mjs"
set EXITCODE=%errorlevel%

if not "%EXITCODE%"=="0" (
  echo.
  echo [提示] 启动过程出现错误（退出码 %EXITCODE%），请把上面的输出发给我排查。
  pause
)
endlocal
