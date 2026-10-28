#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
yt-dlp 下载器封装（纯标准库，只负责"把公开视频抓进片库"）
- 只下载用户自己粘贴的公开链接，不做任何平台签名绕过
- 进度用 --progress-template 输出结构化行，服务端逐行解析
- 画质可选：最高 / 2160 / 1080 / 720 / 480 / 仅音频
"""
import os
import re
import subprocess
import sys
import time

BASE = os.path.dirname(os.path.abspath(__file__))
# MEDIA_UPSCALER_DIR 可覆盖，缺省为同级 ../upscaler（ffmpeg / yt-dlp 都借它的 venv）
UPSCALER_DIR = os.path.abspath(os.environ.get("MEDIA_UPSCALER_DIR")
                               or os.path.normpath(os.path.join(BASE, "..", "upscaler")))
UPSCALER_PY = os.path.join(UPSCALER_DIR, ".venv", "Scripts", "python.exe")
FFMPEG_DIR = os.path.join(UPSCALER_DIR, ".venv", "Lib", "site-packages",
                          "imageio_ffmpeg", "binaries")

# 画质预设：(格式选择器, 是否视频)
QUALITY = {
    "best":  ("bv*+ba/b", True),                          # 该站能给的最高画质
    "2160":  ("bv*[height<=2160]+ba/b[height<=2160]", True),
    "1080":  ("bv*[height<=1080]+ba/b[height<=1080]", True),
    "720":   ("bv*[height<=720]+ba/b[height<=720]", True),
    "480":   ("bv*[height<=480]+ba/b[height<=480]", True),
    "audio": ("ba/b", False),                             # 只要音频，导出 mp3
}
QNAME = {"best": "最高画质", "2160": "≤2160p", "1080": "≤1080p",
         "720": "≤720p", "480": "≤480p", "audio": "仅音频 MP3"}

PROG_TPL = ("download:PROG|%(progress._percent_str)s|%(progress._downloaded_bytes_str)s"
            "|%(progress._total_bytes_str)s|%(progress._total_bytes_estimate_str)s"
            "|%(progress._speed_str)s|%(progress._eta_str)s")
OUT_TPL = "%(title).120B.%(ext)s"

PROG_RE = re.compile(r"^PROG\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)$")
NOISY = ("[download] Destination", "[hlsnative]", "[dashsegments]",
         "Deleting original file", "[FixupM3u8]", "[FixupM4a]", "[Metadata]")

_cache = {"py": None, "ver": None, "tried": False}


# ------------------------------------------------------------------ 环境探测
def find_ffmpeg():
    """优先用超分工具里的 imageio-ffmpeg（无需另装）。"""
    if os.path.isdir(FFMPEG_DIR):
        for n in sorted(os.listdir(FFMPEG_DIR)):
            if n.lower().startswith("ffmpeg") and n.lower().endswith(".exe"):
                return os.path.join(FFMPEG_DIR, n)
    for p in ("ffmpeg.exe", "ffmpeg"):
        if os.path.isfile(p):
            return p
    return None


def resolve():
    """找一个装了 yt-dlp 的 python，返回 (python, 版本号)。结果缓存。"""
    if _cache["tried"]:
        return _cache["py"], _cache["ver"]
    _cache["tried"] = True
    cands = [sys.executable]
    if os.path.isfile(UPSCALER_PY) and os.path.normcase(UPSCALER_PY) != os.path.normcase(sys.executable):
        cands.append(UPSCALER_PY)
    for py in cands:
        try:
            r = subprocess.run([py, "-m", "yt_dlp", "--version"],
                               capture_output=True, text=True, timeout=25,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            ver = (r.stdout or "").strip().splitlines()
            if r.returncode == 0 and ver:
                _cache["py"], _cache["ver"] = py, ver[0]
                return py, ver[0]
        except Exception:
            continue
    return None, None


# ------------------------------------------------------------------ 命令拼装
def build_cmd(py, url, out_dir, quality="best", playlist=False, ffmpeg=None):
    fmt, is_video = QUALITY.get(quality, QUALITY["best"])
    cmd = [py, "-m", "yt_dlp",
           "--newline", "--progress", "--no-color", "--no-warnings",
           "--no-mtime", "--no-overwrites", "--no-simulate",
           "--retries", "5", "--fragment-retries", "10",
           "--concurrent-fragments", "4",
           "--progress-template", PROG_TPL,
           "--print", "before_dl:__TITLE__%(title)s",
           "--print", "after_move:__FILE__%(filepath)s",
           "-P", out_dir,
           "-o", OUT_TPL,
           "-f", fmt,
           "--yes-playlist" if playlist else "--no-playlist"]
    if is_video:
        # 分辨率优先，同分辨率下优先 H.264 —— 浏览器/电视盒子都能直接播
        cmd += ["-S", "res,vcodec:h264", "--merge-output-format", "mp4"]
    else:
        cmd += ["-x", "--audio-format", "mp3", "--audio-quality", "0"]
    if ffmpeg:
        cmd += ["--ffmpeg-location", ffmpeg]
    cmd.append(url)
    return cmd


def _num(s):
    s = (s or "").strip().replace("%", "")
    try:
        return float(s)
    except ValueError:
        return None


# ------------------------------------------------------------------ 执行
def run(job, url, out_dir, quality="best", playlist=False):
    """阻塞执行一次下载，把进度写到 job 里（job 由 server 持有）。"""
    py, ver = resolve()
    if not py:
        job["status"] = "error"
        job["error"] = "没找到 yt-dlp，请在 upscaler 的 venv 里 pip install yt-dlp"
        return
    ff = find_ffmpeg()
    cmd = build_cmd(py, url, out_dir, quality, playlist, ff)
    job["cmd"] = " ".join(cmd)
    job["stage"] = "probe"
    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="ignore", bufsize=1,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception as e:
        job["status"] = "error"
        job["error"] = f"启动失败: {e}"
        return
    job["pid"] = proc.pid

    for raw in proc.stdout:
        line = raw.rstrip()
        if not line:
            continue
        if line.startswith("__TITLE__"):
            job["title"] = line[9:].strip()[:160]
            continue
        if line.startswith("__FILE__"):
            f = line[8:].strip().strip('"')
            job["file"] = f
            job["out_rel"] = os.path.relpath(f, out_dir).replace("\\", "/") if f else ""
            continue
        m = PROG_RE.match(line)
        if m:
            p = _num(m.group(1))
            if p is not None:
                job["percent"] = round(min(100.0, max(0.0, p)), 1)
            total = (m.group(3) or "").strip()
            if total in ("", "NA", "N/A"):
                total = (m.group(4) or "").strip()
            job["size"] = "" if total in ("NA", "N/A") else total
            job["speed"] = (m.group(5) or "").strip()
            job["eta"] = (m.group(6) or "").strip()
            if job.get("stage") in ("probe", None):
                job["stage"] = "download"
            continue
        if "Merging formats" in line:
            job["stage"] = "merge"
            job["percent"] = max(job.get("percent") or 0, 99.0)
            continue
        if "ExtractAudio" in line:
            job["stage"] = "audio"
            continue
        if line.startswith("ERROR:") or line.startswith("WARNING:"):
            job["log"].append(line[:300])
        elif not line.startswith(NOISY):
            job["log"].append(line[:300])
        if len(job["log"]) > 80:
            del job["log"][:-80]

    rc = proc.wait()
    job["finished"] = time.time()
    job["pid"] = None
    f = job.get("file")
    if job.get("cancelled"):
        job["status"] = "cancelled"
        for p in (f, f + ".part"):
            try:
                if p and os.path.isfile(p):
                    os.remove(p)
            except OSError:
                pass
    elif rc == 0 and f and os.path.isfile(f):
        job["status"] = "done"
        job["percent"] = 100.0
        job["stage"] = "done"
        try:
            sz = os.path.getsize(f)
            job["size_h"] = f"{sz/1024/1024:.1f} MB" if sz > 1048576 else f"{sz/1024:.0f} KB"
        except OSError:
            pass
    elif rc == 0 and not f:
        # 已存在同名文件时 yt-dlp 跳过下载，不打印 filepath
        job["status"] = "done"
        job["percent"] = 100.0
        job["stage"] = "done"
        job["note"] = "文件已存在，跳过下载"
    else:
        job["status"] = "error"
        tail = [x for x in job["log"][-6:] if x.startswith("ERROR")]
        job["error"] = (tail[-1] if tail else f"下载失败（退出码 {rc}）")[:300]
