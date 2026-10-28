@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PY=%~dp0.venv\Scripts\python.exe"
if not exist "%PY%" (
  echo [错误] 未找到虚拟环境，请先双击 setup.bat 初始化。
  pause
  exit /b 1
)
if not exist "%~dp0tools\realesrgan\realesrgan-ncnn-vulkan.exe" (
  echo [错误] 未找到 Real-ESRGAN 引擎，请先双击 setup.bat。
  pause
  exit /b 1
)

set "INPUT=%~1"
if "%INPUT%"=="" (
  echo.
  echo 请把视频文件拖到本窗口，或直接粘贴路径，然后回车：
  set /p INPUT=
)
set "INPUT=%INPUT:"=%"
if not exist "%INPUT%" (
  echo [错误] 文件不存在：%INPUT%
  pause
  exit /b 1
)

echo.
echo 选择放大倍数：2 / 3 / 4
echo   2 = 快，480p->960p / 720p->1440p（推荐日常）
echo   4 = 慢，画质上限更高
set "SCALE="
set /p SCALE=倍数 [默认 2]:
if "%SCALE%"=="" set "SCALE=2"

echo.
echo 选择模型：1=通用视频(快)  2=真人/实拍(4x,慢)
set "MODEL=realesr-animevideov3"
set "PICK="
set /p PICK=选择 [默认 1]:
if "%PICK%"=="2" set "MODEL=realesrgan-x4plus"

echo.
echo ===== 开始处理 =====
"%PY%" "%~dp0upscale.py" "%INPUT%" --scale %SCALE% --model %MODEL%

echo.
pause
