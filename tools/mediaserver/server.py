#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地私人影院服务器（纯标准库，无需第三方依赖）
- 扫描 library/ 目录，浏览器里列出所有视频，点开即播
- /api/stream 支持 HTTP Range（可拖动进度、边下边播，不整档下载）
- /api/thumb  自动抽帧生成海报（也可在视频旁放同名 .jpg 当作自定义封面）
- /api/progress 观看进度记忆（本地 JSON，支持"继续观看"）
- /api/upscale 一键调用 ../upscaler 做 AI 超分，进度实时回传，成品自动入库
- 仅绑定 127.0.0.1，纯本地、不对外
"""
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

import agg
import dl

BASE = os.path.dirname(os.path.abspath(__file__))
# MEDIA_LIBRARY_DIR：允许把片库指到别的位置（比如另一块盘的视频归档）；
# 缺省仍是本目录下的 library/。工作台（DevServerManager）用它统一管理路径。
LIB = os.path.abspath(os.environ.get("MEDIA_LIBRARY_DIR") or os.path.join(BASE, "library"))
CACHE = os.path.join(BASE, ".cache")
THUMBS = os.path.join(CACHE, "thumbs")
JOBDIR = os.path.join(CACHE, "jobs")
PROGRESS_FILE = os.path.join(CACHE, "progress.json")
STATIC = os.path.join(BASE, "static")
PORT = int(os.environ.get("PORT", "8888"))
HOST = "127.0.0.1"

VIDEO_EXT = {".mp4", ".m4v", ".mkv", ".webm", ".mov", ".ts", ".avi", ".flv", ".m3u8", ".mpd"}
COVER_EXT = (".jpg", ".jpeg", ".png", ".webp")

# 超分工具位置（MEDIA_UPSCALER_DIR 可覆盖，缺省为同级 ../upscaler）
UPSCALER_DIR = os.path.abspath(os.environ.get("MEDIA_UPSCALER_DIR")
                               or os.path.normpath(os.path.join(BASE, "..", "upscaler")))
UPSCALER_SCRIPT = os.path.join(UPSCALER_DIR, "upscale.py")
UPSCALER_PY = os.path.join(UPSCALER_DIR, ".venv", "Scripts", "python.exe")

JOBS = {}                 # id -> dict
JOBS_LOCK = threading.Lock()
PROG_LOCK = threading.Lock()

# yt-dlp 下载任务（独立队列，最多同时跑 2 个）
DLJOBS = {}
DL_LOCK = threading.Lock()
DL_SEM = threading.Semaphore(2)


def _dl_worker(job, url, quality, playlist):
    with DL_SEM:
        if job.get("cancelled"):
            job["status"] = "cancelled"
            return
        job["stage"] = "probe"
        dl.run(job, url, LIB, quality, playlist)

# 中间帧放系统临时目录（体积巨大，且不能污染片库）
WORKROOT = os.path.join(tempfile.gettempdir(), "localcinema_upscale")

_ffmpeg_cache = {"path": None}


# ---------------------------------------------------------------- 工具函数
def human(n):
    for u in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.0f}{u}" if u == "B" else f"{n:.1f}{u}"
        n /= 1024
    return f"{n:.1f}PB"


def find_ffmpeg():
    if _ffmpeg_cache["path"]:
        return _ffmpeg_cache["path"]
    cands = [
        os.path.join(UPSCALER_DIR, ".venv", "Lib", "site-packages", "imageio_ffmpeg", "binaries"),
        os.path.join(BASE, ".venv", "Lib", "site-packages", "imageio_ffmpeg", "binaries"),
    ]
    for d in cands:
        if os.path.isdir(d):
            exes = [f for f in os.listdir(d) if f.lower().startswith("ffmpeg") and f.lower().endswith(".exe")]
            if exes:
                _ffmpeg_cache["path"] = os.path.join(d, sorted(exes)[-1])
                return _ffmpeg_cache["path"]
    p = shutil.which("ffmpeg")
    if p:
        _ffmpeg_cache["path"] = p
    return _ffmpeg_cache["path"]


def list_videos():
    items = []
    if not os.path.isdir(LIB):
        return items
    for root, dirs, files in os.walk(LIB):
        dirs[:] = [d for d in dirs if not d.startswith("_frames_")]
        for fn in files:
            if os.path.splitext(fn)[1].lower() in VIDEO_EXT:
                p = os.path.join(root, fn)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                rel = os.path.relpath(p, LIB).replace("\\", "/")
                items.append({
                    "name": fn,
                    "stem": os.path.splitext(fn)[0],
                    "rel": rel,
                    "size": st.st_size,
                    "size_h": human(st.st_size),
                    "mtime": int(st.st_mtime),
                    "upscaled": rel.startswith("_已修复/"),
                })
    items.sort(key=lambda x: (-x["mtime"], x["rel"]))
    return items


def safe_path(rel):
    full = os.path.realpath(os.path.join(LIB, urllib.parse.unquote(rel)))
    lib_real = os.path.realpath(LIB)
    if not (full == lib_real or full.startswith(lib_real + os.sep)):
        return None
    return full


def thumb_for(full, rel):
    """返回可直接用作 <img src> 的本地文件路径；无 ffmpeg 且无自定义封面时返回 None。"""
    # 1) 用户自己放的同名封面（最高优先级）
    stem = os.path.splitext(full)[0]
    for ext in COVER_EXT:
        for cand in (stem + ext, stem + ext.upper()):
            if os.path.isfile(cand):
                return cand
    # 2) 缓存过就直接用
    try:
        st = os.stat(full)
    except OSError:
        return None
    key = hashlib.md5(f"{rel}|{st.st_size}|{int(st.st_mtime)}".encode("utf-8")).hexdigest()[:16]
    out = os.path.join(THUMBS, key + ".jpg")
    if os.path.isfile(out) and os.path.getsize(out) > 0:
        return out
    # 3) 抽帧生成
    ff = find_ffmpeg()
    if not ff:
        return None
    os.makedirs(THUMBS, exist_ok=True)
    for ss in ("6", "2", "0"):
        tmp = out + ".tmp.jpg"
        cmd = [ff, "-y", "-hide_banner", "-loglevel", "error", "-ss", ss, "-i", full,
               "-frames:v", "1", "-vf", "scale=520:-2", "-q:v", "5", tmp]
        try:
            subprocess.run(cmd, timeout=40,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except Exception:
            return None
        if os.path.isfile(tmp) and os.path.getsize(tmp) > 0:
            try:
                os.replace(tmp, out)
            except OSError:
                pass
            return out
        if os.path.isfile(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
    return None


# ---------------------------------------------------------------- 进度存储
def load_progress():
    try:
        with open(PROGRESS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_progress(data):
    os.makedirs(CACHE, exist_ok=True)
    tmp = PROGRESS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, PROGRESS_FILE)


# ---------------------------------------------------------------- 修复任务
def job_progress(job):
    """读 upscale.py 写的进度文件，合并进 job 视图。"""
    pf = job.get("progress_file")
    p = {}
    if pf and os.path.isfile(pf):
        try:
            with open(pf, "r", encoding="utf-8") as f:
                p = json.load(f)
        except Exception:
            p = {}
    stage_map = {"start": 1, "extract": 3, "upscale": 5, "encode": 95, "done": 100, "error": 0}
    cur, tot = p.get("current", 0), p.get("total", 0)
    base_pc = stage_map.get(p.get("stage", ""), 0)
    if p.get("stage") == "upscale" and tot:
        pct = 5 + (cur / tot) * 88.0
    elif p.get("stage") == "encode":
        pct = 95.0
    elif p.get("stage") == "done":
        pct = 100.0
    else:
        pct = float(base_pc)
    return {
        "stage": p.get("stage", "start"),
        "stage_msg": p.get("msg", ""),
        "current": cur,
        "total": tot,
        "percent": round(min(100.0, pct), 1),
    }


def run_job(job, full_in, out_full, scale, model, limit):
    os.makedirs(os.path.dirname(out_full), exist_ok=True)
    os.makedirs(JOBDIR, exist_ok=True)
    pf = job["progress_file"]
    work = os.path.join(WORKROOT, job["id"])
    py = UPSCALER_PY if os.path.isfile(UPSCALER_PY) else sys.executable
    cmd = [py, UPSCALER_SCRIPT, full_in, out_full,
           "--scale", str(scale), "--model", model,
           "--progress", pf, "--workdir", work]
    if limit and float(limit) > 0:
        cmd += ["--limit", str(limit)]
    job["cmd"] = " ".join(cmd)
    try:
        proc = subprocess.Popen(
            cmd, cwd=UPSCALER_DIR,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="ignore", bufsize=1,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception as e:
        job["status"] = "error"
        job["error"] = f"启动失败: {e}"
        return
    job["pid"] = proc.pid
    for line in proc.stdout:
        line = line.rstrip()
        if not line:
            continue
        job["log"].append(line)
        if len(job["log"]) > 60:
            del job["log"][:-60]
    rc = proc.wait()
    job["finished"] = time.time()
    # 中间帧兜底清理（脚本自己会删；这里再兜一次，失败不影响判定）
    shutil.rmtree(work, ignore_errors=True)

    out_ok = os.path.isfile(out_full) and os.path.getsize(out_full) > 1024
    if job.get("cancelled"):
        job["status"] = "cancelled"
        if out_ok:
            try:
                os.remove(out_full)
            except OSError:
                pass
    elif out_ok:
        # 成品存在就算成功（收尾清理报错不影响成品）
        job["status"] = "done"
        job["out_size_h"] = human(os.path.getsize(out_full))
        if rc != 0:
            job["log"].append(f"[提示] 脚本退出码 {rc}，但成品已生成，判定为成功")
    else:
        job["status"] = "error"
        job["error"] = f"处理失败（退出码 {rc}）"
        if job["log"]:
            job["error"] += "：" + job["log"][-1][:120]


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "LocalCinema/2.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # 安静

    # ---- 输出helpers
    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _body_json(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8", "ignore") or "{}")
        except Exception:
            return {}

    def _send_file(self, path, ctype=None, cache=True):
        try:
            fsize = os.path.getsize(path)
        except OSError:
            return self._send(404, {"error": "not found"})
        ctype = ctype or mimetypes.guess_type(path)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(fsize))
        self.send_header("Cache-Control", "public, max-age=604800" if cache else "no-store")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(path, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break

    # ---- GET
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path in ("/", "/index.html"):
            idx = os.path.join(BASE, "index.html")
            if os.path.isfile(idx):
                with open(idx, "rb") as f:
                    return self._send(200, f.read(), "text/html; charset=utf-8")
            return self._send(404, "index.html missing", "text/plain; charset=utf-8")

        if path.startswith("/static/"):
            name = os.path.basename(path)
            fp = os.path.join(STATIC, name)
            if os.path.isfile(fp):
                return self._send_file(fp)
            return self._send(404, {"error": "not found"})

        if path == "/api/list":
            prog = load_progress()
            items = list_videos()
            cont = []
            for it in items:
                pr = prog.get(it["rel"])
                if pr:
                    it["pos"] = pr.get("t", 0)
                    it["dur"] = pr.get("d", 0)
                    d = pr.get("d", 0) or 0
                    t = pr.get("t", 0) or 0
                    if d > 20 and 3 < t < d * 0.97:
                        cont.append({
                            "rel": it["rel"], "name": it["name"],
                            "t": t, "d": d, "ts": pr.get("ts", 0),
                            "left": int(d - t),
                        })
            cont.sort(key=lambda x: -x["ts"])
            return self._send(200, {
                "library": LIB, "items": items, "continue": cont[:12],
                "upscaler": os.path.isfile(UPSCALER_SCRIPT),
                "ffmpeg": bool(find_ffmpeg()),
            })

        if path == "/api/thumb":
            rel = (qs.get("f") or [""])[0]
            full = safe_path(rel)
            if not full or not os.path.isfile(full):
                return self._send(404, {"error": "not found"})
            tp = thumb_for(full, rel)
            if not tp:
                return self._send(404, {"error": "no thumb"})
            return self._send_file(tp)

        if path == "/api/progress":
            return self._send(200, load_progress())

        if path == "/api/jobs":
            with JOBS_LOCK:
                out = []
                for j in sorted(JOBS.values(), key=lambda x: -x["created"]):
                    v = {k: j.get(k) for k in
                         ("id", "rel", "name", "out_rel", "scale", "model", "limit",
                          "status", "created", "out_size_h", "error")}
                    v["progress"] = job_progress(j) if j["status"] == "running" else {
                        "percent": 100.0 if j["status"] == "done" else job_progress(j)["percent"],
                        "stage": j["status"], "stage_msg": "", "current": 0, "total": 0}
                    v["log"] = j["log"][-6:]
                    out.append(v)
            return self._send(200, {"jobs": out})

        if path == "/api/stream":
            rel = (qs.get("f") or [""])[0]
            if not rel:
                return self._send(400, {"error": "missing f"})
            full = safe_path(rel)
            if not full or not os.path.isfile(full):
                return self._send(404, {"error": "not found"})
            return self._stream_file(full)

        # ---------------- yt-dlp 下载 ----------------
        if path == "/api/dl":
            py, ver = dl.resolve()
            with DL_LOCK:
                out = []
                for j in sorted(DLJOBS.values(), key=lambda x: -x["created"]):
                    v = {k: j.get(k) for k in
                         ("id", "url", "title", "status", "created", "quality",
                          "percent", "size", "size_h", "speed", "eta", "stage",
                          "out_rel", "error", "note")}
                    v["log"] = (j.get("log") or [])[-4:]
                    out.append(v)
            return self._send(200, {"ok": bool(py), "version": ver,
                                    "ffmpeg": bool(dl.find_ffmpeg()), "jobs": out})

        # ---------------- 聚合搜索 ----------------
        if path == "/api/sources":
            return self._send(200, {"sources": agg.load_sources()})

        if path == "/api/agg/search":
            wd = (qs.get("wd") or [""])[0].strip()
            page = int((qs.get("pg") or ["1"])[0] or 1)
            if not wd:
                return self._send(400, {"error": "缺少搜索词"})
            try:
                return self._send(200, agg.search(wd, page))
            except Exception as e:
                return self._send(500, {"error": f"搜索失败: {e}"})

        if path == "/api/agg/detail":
            src = (qs.get("s") or [""])[0]
            vid = (qs.get("id") or [""])[0]
            if not src or not vid:
                return self._send(400, {"error": "缺少参数"})
            try:
                d = agg.detail(src, vid)
            except Exception as e:
                return self._send(500, {"error": f"取详情失败: {e}"})
            if not d:
                return self._send(404, {"error": "该源没返回这个片"})
            return self._send(200, d)

        if path == "/api/agg/proxy":
            raw = (qs.get("u") or [""])[0]
            try:
                target = agg.b64d(raw)
            except Exception:
                return self._send(400, {"error": "bad url token"})
            try:
                ctype, body = agg.fetch_for_proxy(target)
            except Exception as e:
                return self._send(502, {"error": str(e)})
            return self._send(200, body, ctype)

        return self._send(404, {"error": "not found"})

    def do_HEAD(self):
        return self.do_GET()

    # ---- POST
    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/progress":
            d = self._body_json()
            rel, t, dur = d.get("rel"), d.get("t"), d.get("d")
            if not rel:
                return self._send(400, {"error": "missing rel"})
            with PROG_LOCK:
                data = load_progress()
                if dur and float(dur) > 0:
                    data[rel] = {"t": round(float(t or 0), 2), "d": round(float(dur), 2),
                                 "ts": int(time.time())}
                else:
                    data.pop(rel, None)
                save_progress(data)
            return self._send(200, {"ok": True})

        if path == "/api/upscale":
            d = self._body_json()
            rel = d.get("rel") or ""
            full = safe_path(rel)
            if not full or not os.path.isfile(full):
                return self._send(404, {"error": "文件不存在"})
            if not os.path.isfile(UPSCALER_SCRIPT):
                return self._send(400, {"error": f"找不到超分工具: {UPSCALER_SCRIPT}"})
            scale = int(d.get("scale") or 2)
            model = d.get("model") or "realesr-animevideov3"
            limit = float(d.get("limit") or 0)
            stem = os.path.splitext(os.path.basename(full))[0]
            out_dir = os.path.join(LIB, "_已修复")
            out_name = f"{stem}_{scale}x_AI修复.mp4"
            out_full = os.path.join(out_dir, out_name)
            i = 2
            while os.path.isfile(out_full):
                out_name = f"{stem}_{scale}x_AI修复({i}).mp4"
                out_full = os.path.join(out_dir, out_name)
                i += 1
            jid = uuid.uuid4().hex[:8]
            os.makedirs(JOBDIR, exist_ok=True)
            pf = os.path.join(JOBDIR, jid + ".json")
            job = {
                "id": jid, "rel": rel, "name": os.path.basename(full),
                "out_rel": f"_已修复/{out_name}", "scale": scale, "model": model,
                "limit": limit, "status": "running", "created": int(time.time()),
                "progress_file": pf, "log": [], "pid": None,
            }
            with JOBS_LOCK:
                JOBS[jid] = job
            th = threading.Thread(target=run_job, args=(job, full, out_full, scale, model, limit), daemon=True)
            th.start()
            return self._send(200, {"ok": True, "id": jid, "out_rel": job["out_rel"]})

        if path == "/api/jobs/cancel":
            d = self._body_json()
            jid = d.get("id") or ""
            with JOBS_LOCK:
                job = JOBS.get(jid)
            if not job:
                return self._send(404, {"error": "no such job"})
            job["cancelled"] = True
            pid = job.get("pid")
            if pid:
                try:
                    subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                                   capture_output=True,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                except Exception:
                    pass
            return self._send(200, {"ok": True})

        if path == "/api/jobs/clear":
            with JOBS_LOCK:
                for k in [k for k, v in JOBS.items() if v["status"] != "running"]:
                    JOBS.pop(k, None)
            return self._send(200, {"ok": True})

        # ---------------- yt-dlp 下载 ----------------
        if path == "/api/dl":
            d = self._body_json()
            raw = d.get("urls")
            if raw is None:
                raw = d.get("url") or ""
            if isinstance(raw, str):
                raw = raw.splitlines()
            if not isinstance(raw, list):
                return self._send(400, {"error": "urls 格式不对"})
            urls, bad = [], []
            for u in raw:
                u = str(u or "").strip()
                if not u:
                    continue
                nu = agg.safe_url(u, allow_private=True)
                (urls if nu else bad).append(nu or u)
            if not urls:
                return self._send(400, {"error": "没收到可用的下载地址"})
            urls = urls[:20]
            py, _ver = dl.resolve()
            if not py:
                return self._send(400, {"error": "还没装 yt-dlp：在 upscaler 的 venv 里 pip install yt-dlp"})
            quality = str(d.get("quality") or "best")
            if quality not in dl.QUALITY:
                quality = "best"
            playlist = bool(d.get("playlist"))
            ids = []
            for u in urls:
                jid = uuid.uuid4().hex[:8]
                job = {"id": jid, "url": u, "title": u[:80], "quality": quality,
                       "status": "running", "stage": "queue", "created": int(time.time()),
                       "percent": 0.0, "size": "", "speed": "", "eta": "",
                       "log": [], "pid": None}
                with DL_LOCK:
                    DLJOBS[jid] = job
                threading.Thread(target=_dl_worker,
                                 args=(job, u, quality, playlist), daemon=True).start()
                ids.append(jid)
            return self._send(200, {"ok": True, "ids": ids, "count": len(ids),
                                    "skipped": bad[:5]})

        if path == "/api/dl/cancel":
            d = self._body_json()
            jid = d.get("id") or ""
            with DL_LOCK:
                job = DLJOBS.get(jid)
            if not job:
                return self._send(404, {"error": "no such job"})
            job["cancelled"] = True
            pid = job.get("pid")
            if pid:
                try:
                    subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                                   capture_output=True,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                except Exception:
                    pass
            return self._send(200, {"ok": True})

        if path == "/api/dl/clear":
            with DL_LOCK:
                for k in [k for k, v in DLJOBS.items() if v["status"] != "running"]:
                    DLJOBS.pop(k, None)
            return self._send(200, {"ok": True})

        # ---------------- 聚合源管理 ----------------
        if path == "/api/sources/import":
            d = self._body_json()
            text = str(d.get("text") or "")
            src_url = str(d.get("url") or "").strip()
            if src_url and not text.strip():
                try:
                    text = agg.fetch_text(src_url)
                except Exception as e:
                    return self._send(400, {"error": f"拉取订阅失败：{e}"})
            try:
                r = agg.parse_source_text(text)
            except Exception as e:
                return self._send(400, {"error": f"解析失败：{e}"})
            have = {s["api"] for s in agg.load_sources()}
            for c in r["candidates"]:
                c["exists"] = c["api"] in have
            r["existing"] = len(have)
            return self._send(200, r)

        if path == "/api/sources":
            d = self._body_json()
            items = d.get("sources")
            if not isinstance(items, list):
                return self._send(400, {"error": "sources 必须是数组"})
            clean, seen = [], set()
            for s in items:
                if not isinstance(s, dict):
                    continue
                api = agg.safe_url(str(s.get("api") or "").strip(), allow_private=True)
                if not api:
                    return self._send(400, {"error": f"接口地址不合法: {s.get('api')}"})
                if api in seen:
                    continue
                seen.add(api)
                clean.append({"name": str(s.get("name") or api)[:40],
                              "api": api, "enabled": bool(s.get("enabled", True))})
            agg.save_sources(clean)
            return self._send(200, {"ok": True, "sources": clean})

        if path == "/api/sources/test":
            d = self._body_json()
            api = agg.safe_url(str(d.get("api") or "").strip(), allow_private=True)
            if not api:
                return self._send(400, {"error": "接口地址不合法"})
            url = agg._api_url(api, {"ac": "videolist", "wd": "测试", "pg": 1})
            t = time.time()
            try:
                ctype, data, _ = agg.http_get(url, timeout=10)
                n = len(agg._parse_vod(data, api))
                return self._send(200, {"ok": True, "ms": int((time.time() - t) * 1000),
                                        "items": n, "preview": data[:120].decode("utf-8", "ignore")})
            except Exception as e:
                return self._send(200, {"ok": False, "ms": int((time.time() - t) * 1000),
                                        "error": f"{type(e).__name__}: {e}"})

        return self._send(404, {"error": "not found"})

    # ---- 视频流（Range）
    def _stream_file(self, full):
        fsize = os.path.getsize(full)
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        start, end, status = 0, fsize - 1, 200
        rng = self.headers.get("Range")
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng.strip())
            if m:
                s, e = m.group(1), m.group(2)
                if s == "" and e != "":
                    start = max(0, fsize - int(e))
                    end = fsize - 1
                else:
                    start = int(s) if s else 0
                    end = int(e) if e else fsize - 1
                if start > end or start >= fsize:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{fsize}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{fsize}")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(full, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(262144, left))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
                left -= len(chunk)


def sweep_works():
    """只清理临时工作区里超过 24h 的遗留（绝不碰片库里的任何文件）。
    任何异常都吞掉——清理失败不能影响服务启动。"""
    now = time.time()
    n = 0
    try:
        if not os.path.isdir(WORKROOT):
            return 0
        for name in os.listdir(WORKROOT):
            p = os.path.join(WORKROOT, name)
            try:
                if os.path.isdir(p) and now - os.path.getmtime(p) > 86400:
                    shutil.rmtree(p, ignore_errors=True)
                    n += 1
            except BaseException:
                pass
    except BaseException:
        pass
    return n


def main():
    for d in (LIB, CACHE, THUMBS, JOBDIR):
        os.makedirs(d, exist_ok=True)
    try:
        n = sweep_works()
    except BaseException:
        n = 0
    print("=" * 58)
    print("  本地私人影院 2.0（仅本机可访问）")
    print(f"  片库目录: {LIB}")
    print(f"  浏览器打开: http://{HOST}:{PORT}")
    print(f"  AI 修复: {'就绪 ' + os.path.basename(UPSCALER_DIR) if os.path.isfile(UPSCALER_SCRIPT) else '未找到 upscaler'}")
    print(f"  缩略图: {'可用' if find_ffmpeg() else '无 ffmpeg（用占位封面）'}")
    _py, _ver = dl.resolve()
    print(f"  yt-dlp: {('v' + _ver) if _ver else '未安装（下载功能不可用）'}")
    if n:
        print(f"  已清理 {n} 个遗留中间帧目录")
    print("  按 Ctrl+C 停止")
    print("=" * 58)
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.daemon_threads = True
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
