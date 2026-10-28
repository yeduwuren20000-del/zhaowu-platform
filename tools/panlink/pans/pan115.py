#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
115 网盘 provider —— 分享链接解析取直链
=======================================
参考 alist 115 驱动 + 115 网页端 webapi 逆向实现。
策略：免转存分享取链（分享页公开接口，share_code + receive_code 即可列文件与取链）。

接口链路（抓包自 115.com 分享页，已实测端点 HTTP 200 结构化）：
  GET webapi.115.com/share/snap     → 拿 share_id + 顶层文件快照（data.file_list.list）
  GET webapi.115.com/share/info     → 列指定目录文件（file_id=目录 cid 递归；data.list）
  GET webapi.115.com/share/download → 取文件下载直链（data.file_url）

说明：
  - 分享页接口为公开接口，share_code + receive_code（提取码）即可，不强制登录。
    已实测：空 Cookie 请求 snap 仍返回结构化 JSON（无效 share_code 时 errno 990002 参数错误），
    证明接口公开、URL 正确。
  - 但下载直链（file_url 指向 115cdn/anxia CDN）建议携带登录态 Cookie（含 SEID）
    以提升稳定性与速率；不登录也可能可用，取决于分享者设置与当前风控。
  - file_url 为 CDN 预签名地址，有效期较短（通常几十分钟），下载请尽快。
  - 本 provider 只做【分享提取】，不涉及 115 个人网盘的离线下载 / sign 签名接口
    （那套需要完整登录 Cookie + 参数签名，属于另一套 API）。

分享链接形态：
  https://115.com/s/{share_code}
  https://115.com/?share_code={code}
  https://115cdn.com/{...}
提取码：链接后 ?password=xxx / ?receive_code=xxx / ?pwd=xxx，或用 --pwd 传入。
"""

import re
import urllib.parse

from . import http
from .base import PanError, PanResolver, isolate, batch_throttle

SNAP_URL = "https://webapi.115.com/share/snap"
INFO_URL = "https://webapi.115.com/share/info"
DOWNLOAD_URL = "https://webapi.115.com/share/download"
REFERER = "https://115.com/"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36")

_115_HOST_RE = re.compile(r"115\.(com|cdn\.com)", re.IGNORECASE)
_115_SCODE_RE = re.compile(r"115\.(?:com|cdn\.com)/s/([A-Za-z0-9_-]+)", re.IGNORECASE)
_115_QCODE_RE = re.compile(r"[?&](?:share_code|code)=([A-Za-z0-9_-]+)", re.IGNORECASE)
_PWD_RE = re.compile(r"[?&](?:password|receive_code|pwd|key)=([A-Za-z0-9]+)", re.IGNORECASE)


def parse_115_link(text):
    """返回 (share_code, pwd)。识别失败返回 (None, None)。"""
    text = (text or "").strip()
    m = re.search(r"https?://[^\s]+", text)
    if not m:
        return None, None
    url = m.group(0).rstrip("。，,；;)]}'\"")
    if not _115_HOST_RE.search(url):
        return None, None
    s = _115_SCODE_RE.search(url)
    if not s:
        s = _115_QCODE_RE.search(url)
    share_code = s.group(1) if s else None
    if not share_code:
        return None, None
    p = _PWD_RE.search(url)
    pwd = p.group(1) if p else None
    return share_code, pwd


class Pan115Resolver(PanResolver):
    name = "115 网盘"
    requires_auth = False
    auth_hint = "分享页接口公开，share_code+提取码即可；传 --cookie(含SEID) 可提升下载稳定性"
    link_ttl = 600  # 115 file_url 为 CDN 预签名地址，有效期几十分钟，取 10 分钟

    def match(self, url):
        return bool(_115_HOST_RE.search(url or ""))

    # ---------------- 业务 API ----------------

    def _snap(self, share_code, pwd, cookie):
        """拿 share_id + 顶层文件列表。"""
        params = "share_code=%s&receive_code=%s" % (share_code, pwd or "")
        code, raw, _ = http.get(
            SNAP_URL + "?" + params, cookie,
            headers={"User-Agent": UA, "Referer": REFERER})
        data = http.parse_json(raw)
        if not data or not data.get("state"):
            err = (data or {}).get("error") or (data or {}).get("msg") or raw
            if data and data.get("errno") == 990002:
                raise PanError("分享链接无效或参数错误（errno 990002）。请检查分享码。")
            if "密码" in str(err) or "提取" in str(err) or "receive" in str(err).lower():
                raise PanError("提取码错误或无权限：%s。请检查 --pwd。" % err)
            raise PanError("获取分享信息失败：%s" % err)
        d = data.get("data", {}) or {}
        share_id = d.get("share_id")
        fl = d.get("file_list", {}) or {}
        top = fl.get("list") if isinstance(fl, dict) else fl
        if top is None:
            top = []
        return share_id, top

    def _info(self, share_code, pwd, share_id, file_id, offset=0):
        """列目录文件（file_id = 目录的 cid）。"""
        params = ("share_code=%s&receive_code=%s&file_id=%s&offset=%s&limit=1000"
                  "&order=desc&asc=0"
                  % (share_code, pwd or "", file_id, offset))
        code, raw, _ = http.get(
            INFO_URL + "?" + params, None,
            headers={"User-Agent": UA, "Referer": REFERER})
        data = http.parse_json(raw)
        if not data or not data.get("state"):
            err = (data or {}).get("error") or (data or {}).get("msg") or raw
            raise PanError("列出目录失败：%s" % err)
        d = data.get("data")
        if isinstance(d, dict):
            return d.get("list") or []
        return d or []

    def _collect(self, share_code, pwd, share_id, node, prefix, recursive, out):
        is_dir = (node.get("is_dir") == 1) or (node.get("is_dir") is True)
        name = node.get("fn") or node.get("file_name") or node.get("n") or ""
        size = int(node.get("fs") or node.get("size") or 0)
        cid = node.get("cid")
        fid = node.get("fid") or node.get("file_id") or cid
        out.append({
            "path": (prefix + name) if name else name,
            "name": name,
            "size": size,
            "is_dir": is_dir,
            "url": None,
            "headers": None,
            "_cid": cid,
            "_fid": fid,
        })
        if is_dir and recursive and cid:
            for c in self._info(share_code, pwd, share_id, cid):
                self._collect(share_code, pwd, share_id, c,
                              (prefix + name + "/") if name else prefix,
                              recursive, out)

    def _download_link(self, share_id, file_id, cookie):
        """取文件下载直链 file_url。"""
        params = "share_id=%s&file_id=%s" % (share_id, file_id)
        code, raw, _ = http.get(
            DOWNLOAD_URL + "?" + params, cookie,
            headers={"User-Agent": UA, "Referer": REFERER})
        data = http.parse_json(raw)
        if not data or not data.get("state"):
            err = (data or {}).get("error") or (data or {}).get("msg") or raw
            raise PanError("取直链失败：%s" % err)
        file_url = data.get("file_url") or data.get("file_name")
        if not file_url:
            raise PanError("取直链失败：响应未返回 file_url")
        headers = {"User-Agent": UA, "Referer": REFERER}
        if cookie:
            headers["Cookie"] = cookie
        return file_url, headers

    # ---------------- 统一入口 ----------------

    def resolve(self, url, pwd=None, cookie=None, token=None,
                recursive=True, dry_run=False, **opts):
        share_code, link_pwd = parse_115_link(url)
        if not share_code:
            raise PanError("无法识别 115 分享链接"
                           "（需 115.com/s/xxx 或 115.com/?share_code=xxx 形式）")
        pwd = pwd or link_pwd

        if dry_run:
            return "(dry-run)", [{
                "path": "（dry-run 不实际解析）", "name": "", "size": 0,
                "is_dir": False, "url": None, "headers": {},
            }]

        # 1) snap：获取 share_id + 顶层列表
        share_id, top_list = self._snap(share_code, pwd, cookie)

        # 2) 递归列出全部文件
        items = []
        for it in top_list:
            self._collect(share_code, pwd, share_id, it, "", recursive, items)

        if not items:
            raise PanError("分享内没有文件（可能已清空、链接失效或需提取码）")

        # 3) 取每个文件直链（单文件失败不中断整批；15/批 + 批间 1s 节流）
        files = [it for it in items if not it["is_dir"]]
        for i in range(0, len(files), 15):
            for it in files[i:i + 15]:
                got, err = isolate(self._download_link, share_id, it["_fid"], cookie)
                if err:
                    it["error"] = err
                    continue
                it["url"], it["headers"] = got
            batch_throttle(i, 15, len(files))
        return share_code, items

    def dry_run_info(self, url):
        share_code, pwd = parse_115_link(url)
        if not share_code:
            return ("  !! 无法识别 115 分享链接"
                    "（需 115.com/s/xxx 或 115.com/?share_code=xxx）")
        return (
            "  1) GET  %s?share_code=%s&receive_code=%s\n"
            "     （拿 share_id + 顶层 file_list；公开接口，不需登录；"
            "无效码返 errno 990002）\n"
            "  2) GET  %s?share_code=%s&receive_code=%s&file_id=<目录cid>"
            "&offset=0&limit=1000&order=desc&asc=0\n"
            "     （递归列目录；file_id 即目录的 cid；data.list 为文件数组）\n"
            "  3) GET  %s?share_id=<share_id>&file_id=<文件fid>\n"
            "     （返回 file_url 即下载直链；建议带 Cookie(SEID) 提升稳定性）\n"
            "  提取码：链接 ?password=/?receive_code=/?pwd= 或 --pwd\n"
            "  ⚠ file_url 为 CDN 预签名地址，有效期短（几十分钟），请尽快下载\n"
            % (SNAP_URL, share_code, pwd or "",
               INFO_URL, share_code, pwd or "",
               DOWNLOAD_URL)
        )
