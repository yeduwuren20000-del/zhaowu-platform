<#
  安装 / 卸载桌面快捷方式（工作台桌面端封装）

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1 -Uninstall

  做的事：
    1) 生成多尺寸图标（data\desktop.ico）—— 纯代码绘制，不引入图片资源；
    2) 在桌面与开始菜单建快捷方式，指向 scripts\desktop.vbs（wscript 隐藏控制台启动）。

  注意：本文件必须保存为 **UTF-8 with BOM**。Windows PowerShell 5.1 会按系统 ANSI（GBK）
  读取无 BOM 的 .ps1，中文字符串会被拆坏导致语法错误。
#>

param(
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$iconPath = Join-Path $root 'data\desktop.ico'
$vbsPath = Join-Path $root 'scripts\desktop.vbs'
$desktop = [Environment]::GetFolderPath('Desktop')
$programs = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'
$linkName = '开发与服务器管理工作台'

function Remove-Links {
  foreach ($dir in @($desktop, $programs)) {
    $lnk = Join-Path $dir ($linkName + '.lnk')
    if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host ("  removed " + $lnk) }
  }
}

if ($Uninstall) {
  Write-Host '卸载桌面快捷方式…'
  Remove-Links
  Write-Host '完成（data\desktop.ico 保留，不影响运行）。'
  return
}

if (-not (Test-Path $vbsPath)) { throw ("找不到启动器：" + $vbsPath) }

# ---- 1) 生成多尺寸图标 ----
# Windows 需要多尺寸：任务栏/标题栏用 16/24/32，资源管理器与高 DPI 用 48/64/128/256。
# 只给单一尺寸会在缩放时发虚，所以一次画全套，写进同一个 .ico。
function New-Icon {
  param([string]$Target)

  Add-Type -AssemblyName System.Drawing

  $sizes = @(16, 24, 32, 48, 64, 128, 256)

  # 画单个尺寸：深色圆角底板 + 三条递减横条（呼应"项目 / 服务器 / 端口"三层）
  function New-Bitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::Transparent)

    # 边距、圆角、线宽按尺寸等比缩放，保证 16px 下也不糊成一团
    $pad = [Math]::Max(1, [int]($size * 0.047))
    $radius = [int]($size * 0.22)
    $bgRect = New-Object System.Drawing.Rectangle $pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad)
    $d = [Math]::Min($radius * 2, [Math]::Min($bgRect.Width, $bgRect.Height))
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($bgRect.X, $bgRect.Y, $d, $d, 180, 90)
    $path.AddArc($bgRect.Right - $d, $bgRect.Y, $d, $d, 270, 90)
    $path.AddArc($bgRect.Right - $d, $bgRect.Bottom - $d, $d, $d, 0, 90)
    $path.AddArc($bgRect.X, $bgRect.Bottom - $d, $d, $d, 90, 90)
    $path.CloseFigure()

    $bgBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 22, 25, 29))
    $g.FillPath($bgBrush, $path)
    $borderPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 76, 141, 253)), ([Math]::Max(1, $size * 0.047))
    $g.DrawPath($borderPen, $path)

    $left = [int]($size * 0.25)
    $barH = [Math]::Max(2, [int]($size * 0.094))
    $gap = [Math]::Max(2, [int]($size * 0.078))
    $maxW = $size - $left - [int]($size * 0.22)
    $bars = @(
      @{ w = $maxW;               c = [System.Drawing.Color]::FromArgb(255, 76, 141, 253) },
      @{ w = [int]($maxW * 0.70); c = [System.Drawing.Color]::FromArgb(255, 70, 180, 92) },
      @{ w = [int]($maxW * 0.86); c = [System.Drawing.Color]::FromArgb(255, 207, 154, 44) }
    )
    $top = [int](($size - (3 * $barH + 2 * $gap)) / 2)
    foreach ($bar in $bars) {
      $brush = New-Object System.Drawing.SolidBrush $bar.c
      $rect = New-Object System.Drawing.Rectangle $left, $top, $bar.w, $barH
      $g.FillRectangle($brush, $rect)
      $top += $barH + $gap
    }

    $g.Dispose()
    return $bmp
  }

  # 组装多尺寸 ICO（PNG 帧，Vista+ 原生支持，画质优于 BMP 帧）
  $frames = @()
  $bitmaps = @()
  foreach ($s in $sizes) {
    $bmp = New-Bitmap $s
    $bitmaps += $bmp
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $frames += ,$ms.ToArray()
    $ms.Dispose()
  }

  $dir = Split-Path -Parent $Target
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

  $fs = [System.IO.File]::Create($Target)
  $bw = New-Object System.IO.BinaryWriter $fs
  try {
    $count = $frames.Count
    $bw.Write([UInt16]0)        # reserved
    $bw.Write([UInt16]1)        # type = icon
    $bw.Write([UInt16]$count)   # 帧数
    $offset = 6 + 16 * $count   # 每张目录项 16 字节

    for ($i = 0; $i -lt $count; $i++) {
      $s = $sizes[$i]
      $dim = if ($s -ge 256) { 0 } else { $s }  # 256 在目录项里记 0
      $bw.Write([Byte]$dim)
      $bw.Write([Byte]$dim)
      $bw.Write([Byte]0)
      $bw.Write([Byte]0)
      $bw.Write([UInt16]1)      # color planes
      $bw.Write([UInt16]32)     # bits per pixel
      $len = $frames[$i].Length
      $bw.Write([UInt32]$len)
      $bw.Write([UInt32]$offset)
      $offset += $len
    }
    foreach ($frame in $frames) { $bw.Write($frame) }
  }
  finally {
    $bw.Dispose()
    $fs.Dispose()
  }

  foreach ($bmp in $bitmaps) { $bmp.Dispose() }
  Write-Host ("  icon generated (" + ($sizes -join '/') + "), " + $count + " sizes")
}

New-Icon -Target $iconPath

# ---- 2) 建快捷方式 ----
$shell = New-Object -ComObject WScript.Shell

foreach ($dir in @($desktop, $programs)) {
  if (-not (Test-Path $dir)) { continue }
  $lnkPath = Join-Path $dir ($linkName + '.lnk')
  $link = $shell.CreateShortcut($lnkPath)
  $link.TargetPath = 'wscript.exe'
  $link.Arguments = '"' + $vbsPath + '"'
  $link.WorkingDirectory = $root
  if (Test-Path $iconPath) { $link.IconLocation = $iconPath + ',0' }
  $link.Description = '开发与服务器管理工作台（本地服务 + 桌面应用窗口）'
  $link.Save()
  Write-Host ("  shortcut created: " + $lnkPath)
}

Write-Host ''
Write-Host '完成。双击桌面「开发与服务器管理工作台」即可：'
Write-Host '  - 后端没在跑会自动拉起；'
Write-Host '  - 以独立应用窗口打开（无地址栏、无标签页）；'
Write-Host '  - 关窗口不停后端，要彻底停止：npm run desktop -- --kill'