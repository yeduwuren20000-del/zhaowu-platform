#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地视频 AI 超分 / 修复工具（私人自用）
管线: 解码 -> 逐帧 Real-ESRGAN 超分 -> 用原音轨重编码 -> 输出 MP4

用法:
  python upscale.py 输入.mp4 输出.mp4 --scale 2 --model realesr-animevideov3
  python upscale.py 输入.mp4 输出.mp4 --scale 4 --model realesrgan-x4plus --gpu 1
  python upscale.py 输入.mp4 输出.mp4 --limit 60          # 只处理前 60 秒（试效果）
  python upscale.py 输入.mp4 输出.mp4 --progress p.json   # 写进度 JSON（给影院调度用）

依赖: 同目录 .venv 里的 imageio-ffmpeg(提供 ffmpeg)，以及 tools/realesrgan/ 下
      的 realesrgan-ncnn-vulkan.exe（RTX 5060 走 Vulkan，无需 CUDA）。
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time

BASE = os.path.dirname(os.path.abspath(__file__))
RE_DIR = os.path.join(BASE, "tools", "realesrgan")
RE_EXE = os.path.join(RE_DIR, "realesrgan-ncnn-vulkan.exe")
RE_MODELS = os.path.join(RE_DIR, "models")

# 视频模型（realesr-animevideov3 支持 2/3/4x，速度最快，最适合连续帧）
VIDEO_MODELS = {"realesr-animevideov3", "realesrgan-x4plus", "realesrgan-x4plus-anime", "realesrnet-x4plus"}

_PROGRESS_FILE = None


def write_progress(stage, current=0, total=0, msg=""):
    """原子写进度 JSON，供外部（比如影院服务）轮询。"""
    if not _PROGRESS_FILE:
        return
    data = {
        "stage": stage,            # extract / upscale / encode / done / error
        "current": int(current),
        "total": int(total),
        "percent": round(min(100.0, current * 100.0 / total), 1) if total else 0,
        "msg": msg,
        "ts": time.time(),
    }
    tmp = _PROGRESS_FILE + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, _PROGRESS_FILE)
    except OSError:
        pass


def find_ffmpeg():
    # 1) imageio-ffmpeg 自带
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass
    # 2) PATH
    p = shutil.which("ffmpeg")
    if p:
        return p
    # 3) 旧版依赖里的固定路径
    cand = os.path.join(BASE, ".venv", "Lib", "site-packages", "imageio_ffmpeg", "binaries")
    if os.path.isdir(cand):
        for f in os.listdir(cand):
            if f.startswith("ffmpeg") and f.endswith(".exe"):
                return os.path.join(cand, f)
    sys.exit("找不到 ffmpeg。请先运行: .venv\\Scripts\\python -m pip install imageio-ffmpeg")


def probe(ffmpeg, path):
    """用 ffmpeg -i 解析时长/分辨率/fps（imageio 不含 ffprobe）。"""
    out = subprocess.run([ffmpeg, "-hide_banner", "-i", path],
                         capture_output=True, text=True, errors="ignore").stderr
    dur = None
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)", out)
    if m:
        dur = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    res = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", out)
    fps = re.search(r"(\d+(?:\.\d+)?)\s*fps", out)
    has_audio = "Audio:" in out
    w = int(res.group(1)) if res else None
    h = int(res.group(2)) if res else None
    f = float(fps.group(1)) if fps else 25.0
    return {"duration": dur, "w": w, "h": h, "fps": f, "audio": has_audio}


def run(cmd, desc):
    print(f"\n>>> {desc}", flush=True)
    print("    " + " ".join(f'"{c}"' if " " in c else c for c in cmd[:6]) + (" ..." if len(cmd) > 6 else ""), flush=True)
    t = time.time()
    r = subprocess.run(cmd)
    if r.returncode != 0:
        write_progress("error", 0, 0, f"{desc} 失败")
        sys.exit(f"[失败] {desc} 退出码 {r.returncode}")
    print(f"    完成，用时 {time.time() - t:.1f}s", flush=True)


def count_png(d):
    try:
        return sum(1 for f in os.listdir(d) if f.lower().endswith(".png"))
    except OSError:
        return 0


def run_tracked(cmd, desc, out_dir, total, stage):
    """跑子进程 + 后台线程数输出帧数，实时写进度。"""
    print(f"\n>>> {desc}", flush=True)
    print("    " + " ".join(f'"{c}"' if " " in c else c for c in cmd[:6]) + (" ..." if len(cmd) > 6 else ""), flush=True)
    t = time.time()
    stop = threading.Event()

    def ticker():
        while not stop.is_set():
            write_progress(stage, count_png(out_dir), total)
            stop.wait(1.0)

    th = threading.Thread(target=ticker, daemon=True)
    th.start()
    try:
        rc = subprocess.run(cmd).returncode
    finally:
        stop.set()
        th.join(timeout=2)
    if rc != 0:
        write_progress("error", 0, 0, f"{desc} 失败")
        sys.exit(f"[失败] {desc} 退出码 {rc}")
    write_progress(stage, total, total)
    print(f"    完成，用时 {time.time() - t:.1f}s", flush=True)


def main():
    global _PROGRESS_FILE

    ap = argparse.ArgumentParser(description="本地视频 AI 超分/修复")
    ap.add_argument("input", help="输入视频")
    ap.add_argument("output", nargs="?", help="输出视频（默认 输入名_upscaled.mp4）")
    ap.add_argument("--scale", type=int, default=2, choices=[2, 3, 4], help="放大倍数(默认2)")
    ap.add_argument("--model", default="realesr-animevideov3", choices=sorted(VIDEO_MODELS),
                    help="超分模型(默认 realesr-animevideov3，最快)")
    ap.add_argument("--gpu", default="1", help="GPU 编号(默认1=NVIDIA；auto=自动)")
    ap.add_argument("--crf", type=int, default=18, help="x264 画质(越小越好，默认18)")
    ap.add_argument("--preset", default="medium", help="x264 预设(默认medium)")
    ap.add_argument("--limit", type=float, default=0,
                    help="只处理前 N 秒（0=整片，试效果时很有用）")
    ap.add_argument("--workdir", default=None,
                    help="中间帧工作目录（默认放在输出文件旁边；大量临时文件建议指到临时盘）")
    ap.add_argument("--progress", default=None, help="进度 JSON 输出路径（供外部轮询）")
    ap.add_argument("--keep-frames", action="store_true", help="保留中间帧")
    args = ap.parse_args()

    _PROGRESS_FILE = args.progress
    write_progress("start")

    if not os.path.isfile(args.input):
        write_progress("error", msg="输入不存在")
        sys.exit(f"输入不存在: {args.input}")
    ffmpeg = find_ffmpeg()
    if not os.path.isfile(RE_EXE):
        write_progress("error", msg="缺少 Real-ESRGAN")
        sys.exit(f"缺少 Real-ESRGAN: {RE_EXE}\n请先运行 setup.bat 下载")

    output = args.output or re.sub(r"(\.[^.]+)$", r"_upscaled\1", args.input)
    if output == args.input:
        sys.exit("输出不能与输入相同")

    # x4plus 系列是固定 4x 模型，scale 需为 4
    if args.model != "realesr-animevideov3" and args.scale != 4:
        print(f"[提示] {args.model} 是 4x 模型，已将 scale 调整为 4", flush=True)
        args.scale = 4

    info = probe(ffmpeg, args.input)
    src_dur = info["duration"] or 0
    eff_dur = min(src_dur, args.limit) if args.limit and src_dur else (args.limit or src_dur)
    est_frames = int(eff_dur * info["fps"]) if eff_dur else 0

    print("=" * 56, flush=True)
    print(f"输入   : {args.input}")
    print(f"输出   : {output}")
    print(f"分辨率 : {info['w']}x{info['h']} -> {info['w'] and info['w']*args.scale}x{info['h'] and info['h']*args.scale}")
    print(f"时长   : {eff_dur and round(eff_dur,1)}s"
          + (f" (整片 {round(src_dur,1)}s，限 {args.limit}s)" if args.limit and src_dur > args.limit else "")
          + f"  帧率: {info['fps']}  音轨: {info['audio']}")
    print(f"模型   : {args.model}  x{args.scale}  GPU={args.gpu}  预计帧数 ≈ {est_frames}")
    print("=" * 56, flush=True)

    if args.workdir:
        work = os.path.abspath(args.workdir)
    else:
        work = os.path.join(os.path.dirname(os.path.abspath(output)),
                            "_frames_" + os.path.splitext(os.path.basename(output))[0])
    frames_in = os.path.join(work, "in")
    frames_out = os.path.join(work, "out")
    os.makedirs(frames_in, exist_ok=True)
    os.makedirs(frames_out, exist_ok=True)

    try:
        # 1) 抽帧（PNG 无损）
        write_progress("extract", 0, 0, "抽帧中")
        cmd = [ffmpeg, "-y", "-i", args.input, "-vsync", "0"]
        if args.limit and args.limit > 0:
            cmd += ["-t", str(args.limit)]
        cmd += [os.path.join(frames_in, "f_%08d.png")]
        run(cmd, "抽帧")

        total = count_png(frames_in) or est_frames or 1
        write_progress("upscale", 0, total, "AI 超分中")

        # 2) AI 超分
        cmd = [RE_EXE, "-i", frames_in, "-o", frames_out,
               "-n", args.model, "-s", str(args.scale),
               "-m", RE_MODELS, "-f", "png"]
        if args.gpu and args.gpu != "auto":
            cmd += ["-g", args.gpu]
        run_tracked(cmd, "Real-ESRGAN 逐帧超分", frames_out, total, "upscale")

        # 3) 重编码 + 原音轨
        write_progress("encode", total, total, "重编码中")
        cmd = [ffmpeg, "-y", "-framerate", str(info["fps"]),
               "-i", os.path.join(frames_out, "f_%08d.png"),
               "-i", args.input,
               "-map", "0:v:0", "-map", "1:a:0?",          # 音轨不存在也不报错
               "-c:v", "libx264", "-crf", str(args.crf), "-preset", args.preset,
               "-pix_fmt", "yuv420p", "-c:a", "copy",
               "-shortest", output]
        run(cmd, "重编码 + 合成音轨")

        write_progress("done", total, total, "完成")
        print("\n" + "=" * 56, flush=True)
        print(f"完成: {output}", flush=True)
        print("=" * 56, flush=True)
    finally:
        if not args.keep_frames and os.path.isdir(work):
            # 清理失败不能影响成品判定（成品已经写好了）
            try:
                shutil.rmtree(work, ignore_errors=True)
            except BaseException:
                pass


if __name__ == "__main__":
    main()
