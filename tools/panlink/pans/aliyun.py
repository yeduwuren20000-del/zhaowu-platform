#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
阿里云盘 provider —— 需用户登录 token（Authorization Bearer）。
============================================================
仿 alist 的 aliyundrive_share 实现：分享文件可「免转存」直接取直链。

★ 接口路径（参考 alist v3.43 / 阿里开放平台，host 为 api.alipan.com）：
  1) POST https://api.alipan.com/v2/share_link/get_share_token   （匿名拿 share_token，需 share_pwd）
  2) POST https://api.alipan.com/adrive/v3/file/list             （列文件，需 Authorization + x-share-token + X-Canary）
  3) POST https://api.alipan.com/adrive/v3/file/download         （免转存换直链，同上头）

★ 需要你自己的阿里云盘 token：登录 https://www.aliyundrive.com 后，
  浏览器 F12 → Network → 任意请求头里的 `Authorization: Bearer xxxx` 复制 xxxx，用 --token 传入。
★ 必须带的 header：X-Canary: client=web,app=share,version=v2.3.1（解除限流/拒绝）。
"""

import re

from . import http
from .base import PanError, PanResolver, isolate, batch_throttle

API = "https://api.alipan.com"
TOKEN_API = API + "/v2/share_link/get_share_token"
LIST_API = API + "/adrive/v3/file/list"
DOWNLOAD_API = API + "/adrive/v3/file/download"
CANARY = "client=web,app=share,version=v2.3.1"

_SHARE_RE = re.compile(r"/(?:s|share)/([a-zA-Z0-9]+)", re.IGNORECASE)


def _norm_token(token):
    if not token:
        return None
    token = token.strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    return token


class AliyunResolver(PanResolver):
    name = "阿里云盘"
    requires_auth = True
    auth_hint = "需 --token（阿里云盘网页版 Authorization Bearer，从浏览器开发者工具复制）"
    link_ttl = 300  # 阿里官方直链有效期约 5 分钟，按最保守值缓存

    def match(self, url):
        return bool("aliyundrive.com" in (url or "") or "alipan.com" in (url or "")
                    or "alidrive.com" in (url or ""))

    def resolve(self, url, pwd=None, cookie=None, token=None,
                recursive=True, dry_run=False, **opts):
        sid = self._share_id(url)
        if not sid:
            raise PanError("无法识别阿里云盘分享链接（需要 aliyundrive.com/s/xxx）")
        token = _norm_token(token)
        if not token:
            raise PanError("阿里云盘需要 --token（你的登录 Bearer），详见 README")

        if dry_run:
            return "(dry-run)", [{"path": "(dry-run)", "name": "", "size": 0,
                                 "is_dir": False, "url": None, "headers": {}}]

        # 1) share_token（匿名，无需 Authorization）
        body = {"share_id": sid, "share_pwd": pwd or ""}
        code, raw, _ = http.post_json(TOKEN_API, None, body)
        data = http.parse_json(raw)
        if not data or "share_token" not in data:
            msg = data.get("message") if isinstance(data, dict) else raw
            raise PanError("获取阿里云盘 share_token 失败: %s" % msg)
        share_token = data["share_token"]

        results = []

        def walk(parent_id, prefix):
            files, drive_id = self._list(share_token, token, parent_id)
            for f in files:
                fid = f.get("file_id")
                name = f.get("name")
                is_dir = f.get("type") == "folder"
                if is_dir and recursive:
                    walk(fid, prefix + (name or fid) + "/")
                else:
                    results.append({
                        "path": prefix + (name or fid),
                        "name": name,
                        "size": f.get("size") or 0,
                        "is_dir": is_dir,
                        "url": None,
                        "headers": {"Authorization": "Bearer %s" % token,
                                    "Referer": "https://www.aliyundrive.com/"},
                        "_fid": fid,
                        "_drive_id": f.get("drive_id") or drive_id,
                    })

        walk("root", "")

        # 2) 逐个取直链（单文件失败不中断整批；15/批 + 批间 1s 节流）
        files = [it for it in results if not it["is_dir"]]
        for i in range(0, len(files), 15):
            for it in files[i:i + 15]:
                got, err = isolate(self._download, share_token, token,
                                   it["_drive_id"], it["_fid"])
                if err:
                    it["error"] = err
                    continue
                durl, size = got
                it["url"] = durl
                if size:
                    it["size"] = size
            batch_throttle(i, 15, len(files))
        return "(阿里云盘分享)", results

    # ---------------- 内部 ----------------

    def _share_id(self, url):
        m = _SHARE_RE.search(url or "")
        if m and m.group(1):
            return m.group(1)
        return None

    def _list(self, share_token, token, parent_id):
        out = []
        marker = "first"
        drive_id = ""
        while marker:
            if marker == "first":
                marker = ""
            body = {
                "image_thumbnail_process": "image/resize,w_160/format,jpeg",
                "image_url_process": "image/resize,w_1920/format,jpeg",
                "limit": 200,
                "order_by": "name",
                "order_direction": "ASC",
                "parent_file_id": parent_id,
                "share_id": "",  # 由 x-share-token 承载
                "video_thumbnail_process": "video/snapshot,t_1000,f_jpg,ar_auto,w_300",
                "marker": marker,
            }
            headers = {"Authorization": "Bearer %s" % token,
                       "X-Share-Token": share_token, "X-Canary": CANARY}
            code, raw, _ = http.post_json(LIST_API, None, body, headers)
            data = http.parse_json(raw)
            if not data or "items" not in data:
                msg = data.get("message") if isinstance(data, dict) else raw
                raise PanError("阿里云盘列文件失败: %s" % msg)
            items = data.get("items", [])
            if not drive_id:
                for it in items:
                    if it.get("drive_id"):
                        drive_id = it["drive_id"]
                        break
            out.extend(items)
            marker = data.get("next_marker") or ""
        return out, drive_id

    def _download(self, share_token, token, drive_id, file_id):
        body = {"drive_id": drive_id, "file_id": file_id, "share_id": ""}
        headers = {"Authorization": "Bearer %s" % token,
                   "X-Share-Token": share_token, "X-Canary": CANARY}
        code, raw, _ = http.post_json(DOWNLOAD_API, None, body, headers)
        data = http.parse_json(raw)
        if not data or "url" not in data:
            msg = data.get("message") if isinstance(data, dict) else raw
            raise PanError("阿里云盘取直链失败: %s" % msg)
        return data.get("url"), data.get("size")

    def dry_run_info(self, url):
        sid = self._share_id(url)
        if not sid:
            return "  !! 无法识别阿里云盘链接"
        return ("  1) POST %s (share_id=%s → share_token，匿名)\n"
                "  2) POST %s (list, 需 Bearer + X-Share-Token + X-Canary)\n"
                "  3) POST %s (download → 直链)\n"
                "  下载需 Authorization: Bearer <token>" % (TOKEN_API, sid,
                                                           LIST_API, DOWNLOAD_API))
