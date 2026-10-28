#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
天翼云盘 provider —— 中国电信 cloud.189.cn，需登录 Cookie。
==============================================================
★ 实验性实现：接口参考 cloud.189.cn 网页端 open API，可能随官方调整。
   分享下载通常需要登录态 Cookie（含 SESSION 等），请用 --cookie 传入。

接口（cloud.189.cn/api/open/share/...）：
  1) getShareInfoByCodeV2.action   （shareCode + accessCode → shareId/fileId）
  2) listShareDirFile.action       （列文件，递归需翻 folder）
  3) getFileDownloadUrl.action     （拿 downloadUrl）
  下载 downloadUrl 需带 Cookie + Referer: https://cloud.189.cn/
"""

import re

from . import http
from .base import PanError, PanResolver, isolate, batch_throttle

BASE = "https://cloud.189.cn"
INFO_API = BASE + "/api/open/share/getShareInfoByCodeV2.action"
LIST_API = BASE + "/api/open/share/listShareDirFile.action"
URL_API = BASE + "/api/open/share/getFileDownloadUrl.action"

_CODE_RE = re.compile(r"(?:code|shareCode)=([a-zA-Z0-9]+)", re.IGNORECASE)
_T_RE = re.compile(r"/t/([a-zA-Z0-9]+)", re.IGNORECASE)
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


class TianyiResolver(PanResolver):
    name = "天翼云盘"
    requires_auth = True
    auth_hint = "需 --cookie（天翼云盘 cloud.189.cn 登录 Cookie，含 SESSION）"

    def match(self, url):
        return "cloud.189.cn" in (url or "")

    def resolve(self, url, pwd=None, cookie=None, token=None,
                recursive=True, dry_run=False, **opts):
        code = self._code(url)
        if not code:
            raise PanError("无法识别天翼云盘分享链接（需要 cloud.189.cn 的 ?code= 或 /t/ 链接）")
        if not cookie:
            raise PanError("天翼云盘需要 --cookie（登录态），详见 README")
        if dry_run:
            return "(dry-run)", [{"path": "(dry-run)", "name": "", "size": 0,
                                 "is_dir": False, "url": None, "headers": {}}]

        info = self._info(code, pwd, cookie)
        share_id = info.get("shareId") or info.get("shareId ")
        file_id = info.get("fileId") or info.get("fileId ")
        if not share_id or not file_id:
            raise PanError("天翼云盘获取分享信息失败（可能需提取码或 Cookie 失效）: %s" % info)
        results = []

        def walk(fid, prefix):
            items = self._list(share_id, fid, cookie)
            for it in items:
                is_dir = bool(it.get("isFolder") or it.get("isDir"))
                name = it.get("fileName") or it.get("name")
                if is_dir and recursive:
                    walk(it.get("fileId"), prefix + (name or "") + "/")
                else:
                    results.append({
                        "path": prefix + (name or it.get("fileId")),
                        "name": name,
                        "size": it.get("fileSize") or it.get("size") or 0,
                        "is_dir": is_dir,
                        "url": None,
                        "headers": {"Cookie": cookie, "Referer": BASE + "/",
                                    "User-Agent": UA},
                        "_file_id": it.get("fileId"),
                    })

        walk(file_id, "")

        # 逐个取直链（单文件失败不中断整批；15/批 + 批间 1s 节流）
        files = [it for it in results if not it["is_dir"]]
        for i in range(0, len(files), 15):
            for it in files[i:i + 15]:
                durl, err = isolate(self._url, share_id, it["_file_id"], cookie)
                if err:
                    it["error"] = err
                    continue
                it["url"] = durl
            batch_throttle(i, 15, len(files))
        return info.get("fileName") or "(天翼云盘分享)", results

    # ---------------- 内部 ----------------

    def _code(self, url):
        m = _CODE_RE.search(url or "")
        if m:
            return m.group(1)
        m = _T_RE.search(url or "")
        if m:
            return m.group(1)
        return None

    def _info(self, code, pwd, cookie):
        fields = {"shareCode": code, "accessCode": pwd or ""}
        code_, raw, _ = http.post_form(INFO_API, cookie, fields,
                                       headers={"User-Agent": UA, "Referer": BASE + "/"})
        data = http.parse_json(raw)
        if not data:
            raise PanError("天翼云盘分享信息接口异常: HTTP %s" % code_)
        return data

    def _list(self, share_id, file_id, cookie):
        fields = {"shareId": share_id, "fileId": file_id, "isFolder": "true",
                  "orderBy": "1", "order": "ASC", "pageNum": "1", "pageSize": "60"}
        code_, raw, _ = http.post_form(LIST_API, cookie, fields,
                                       headers={"User-Agent": UA, "Referer": BASE + "/"})
        data = http.parse_json(raw)
        if not data or "fileList" not in data:
            raise PanError("天翼云盘列文件失败: %s" % (data or raw))
        return data.get("fileList", [])

    def _url(self, share_id, file_id, cookie):
        fields = {"shareId": share_id, "fileId": file_id, "fileType": "1"}
        code_, raw, _ = http.post_form(URL_API, cookie, fields,
                                       headers={"User-Agent": UA, "Referer": BASE + "/"})
        data = http.parse_json(raw)
        if not data or not data.get("fileDownloadUrl"):
            raise PanError("天翼云盘取直链失败: %s" % (data or raw))
        return data.get("fileDownloadUrl")

    def dry_run_info(self, url):
        code = self._code(url)
        if not code:
            return "  !! 无法识别天翼云盘链接"
        return ("  1) POST %s (shareCode=%s → shareId/fileId)\n"
                "  2) POST %s (list)\n"
                "  3) POST %s (download url)\n"
                "  下载需 Cookie + Referer: %s/" % (INFO_API, code, LIST_API,
                                                   URL_API, BASE))
