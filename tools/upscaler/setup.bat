@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ===== 初始化本地视频超分工具 =====

if not exist ".venv\Scripts\python.exe" (
  echo [1/3] 创建 Python 虚拟环境 ...
  py -3 -m venv .venv 2>nul || python -m venv .venv
)

echo [2/3] 安装 imageio-ffmpeg（自带 ffmpeg）...
".venv\Scripts\python.exe" -m pip install --quiet --upgrade imageio-ffmpeg
if errorlevel 1 (
  echo [错误] 安装失败，请检查网络。
  pause & exit /b 1
)

if not exist "tools\realesrgan\realesrgan-ncnn-vulkan.exe" (
  echo [3/3] 下载 Real-ESRGAN 引擎（约 45MB）...
  powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip' -OutFile 'tools\realesrgan.zip'"
  ".venv\Scripts\python.exe" -c "import zipfile;zipfile.ZipFile('tools/realesrgan.zip').extractall('tools/_re')"
  if exist "tools\realesrgan" rmdir /s /q "tools\realesrgan"
  move "tools\_re" "tools\realesrgan" >nul
  del "tools\realesrgan.zip"
) else (
  echo [3/3] Real-ESRGAN 已存在，跳过。
)

echo.
echo 初始化完成！双击 run.bat 开始使用。
pause
