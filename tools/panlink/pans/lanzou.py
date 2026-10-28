#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
蓝奏云 provider —— 无需登录，游客即可取直链（小文件）。
==================================================
蓝奏云分享接口（参考社区公开实现，接口随官方调整而变，以实际抓包为准）：

  1) GET 分享页 https://{host}/{id}
  2) 从页面提取 sign（隐藏域 / JS 变量 / 'sign':'...'）
  3) POST https://{host}/ajaxm.php
        action=downprocess&sign={sign}&ves=1
     返回 {"zt":1,"dom":"...","url":"...","inf":"文件名",...}
  4) 拼接 real = dom + url
  5) GET real（带 Referer: https://{host}/），跟随跳转 / 解析二级 JSON，得最终直链

文件夹分享：分享页含多个子文件链接，逐个按单文件流程递归解析。
"""

import re
import urllib.parse

from . import http
from .base import PanError, PanResolver

LANZOU_RE = re.compile(
    r"(?:https?://)?(?:[a-z0-9]+\.)?lanzou[a-z]{0,2}\.com/[a-zA-Z0-9]+",
    re.IGNORECASE)
_HOST_RE = re.compile(r"(?:https?://)?([a-z0-9]+\.lanzou[a-z]{0,2}\.com)", re.IGNORECASE)

# 蓝奏签名/二级参数的多策略提取
_SIGN_PATTERNS = [
    re.compile(r"name=['\"]sign['\"]\s+value=['\"]([a-f0-9]+)['\"]", re.IGNORECASE),
    re.compile(r"['\"]sign['\"]\s*:\s*['\"]([a-f0-9]+)['\"]", re.IGNORECASE),
    re.compile(r"<input[^>]+name=['\"]sign['\"][^>]+value=['\"]([a-f0-9]+)['\"]", re.IGNORECASE),
    re.compile(r"var\s+\w+\s*=\s*['\"]([a-f0-9]{16,})['\"]"),
]
_WEBSIGN_PATTERNS = [
    re.compile(r"['\"]websign['\"]\s*:\s*['\"]([a-f0-9]+)['\"]", re.IGNORECASE),
    re.compile(r"['\"]websign_t['\"]\s*:\s*['\"]([0-9]+)['\"]", re.IGNORECASE),
]
# 文件夹分享里每个子文件的链接
_SUB_RE = re.compile(
    r"https?://[a-z0-9]+\.lanzou[a-z]{0,2}\.com/[a-zA-Z0-9]+", re.IGNORECASE)

BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def _host_of(url):
    m = _HOST_RE.search(url)
    return m.group(1) if m else None


def _extract_sign(html):
    for pat in _SIGN_PATTERNS:
        m = pat.search(html)
        if m:
            return m.group(1)
    return None


def _extract_websign(html):
    w = None
    t = None
    for pat in _WEBSIGN_PATTERNS:
        m = pat.search(html)
        if m and "websign_t" in pat.pattern:
            t = m.group(1)
        elif m:
            w = m.group(1)
    return w, t


def _join_url(dom, url):
    if not url:
        return dom
    if url.startswith("http"):
        return url
    base = (dom or "").rstrip("/")
    if url.startswith("/"):
        return base + url
    return base + "/" + url


class LanzouResolver(PanResolver):
    name = "蓝奏云"
    requires_auth = False
    auth_hint = "无需登录（游客态可取小文件直链）"

    def match(self, url):
        return bool(LANZOU_RE.search(url or ""))

    def resolve(self, url, pwd=None, cookie=None, token=None,
                recursive=True, dry_run=False, **opts):
        url = self._normalize(url)
        host = _host_of(url)
        if not host:
            raise PanError("无法识别蓝奏云分享链接")

        if dry_run:
            info = ("  1) GET %s （提取 sign）\n"
                    "  2) POST https://%s/ajaxm.php  action=downprocess&sign=...&ves=1\n"
                    "  3) 拼接 dom+url，再 GET（带 Referer: https://%s/）取最终直链"
                    % (url, host, host))
            return "(dry-run)", [{"path": "(dry-run)", "name": "", "size": 0,
                                 "is_dir": False, "url": None, "headers": {}}]

        results = []
        self._walk(url, host, recursive, results)
        return "(蓝奏云分享)", results

    # ---------------- 内部 ----------------

    def _normalize(self, url):
        url = (url or "").strip()
        if not url.startswith("http"):
            url = "https://" + url.lstrip("/")
        return url

    def _walk(self, url, host, recursive, results, prefix=""):
        html = self._get_page(url)
        sign = _extract_sign(html)
        if sign:
            # 单文件分享
            self._resolve_file(url, host, html, sign, results, prefix)
            return
        # 尝试文件夹分享：提取子链接
        subs = []
        for m in _SUB_RE.finditer(html):
            s = m.group(0)
            if s.rstrip("/") != url.rstrip("/") and _host_of(s):
                subs.append(s)
        subs = list(dict.fromkeys(subs))  # 去重保序
        if subs and recursive:
            for s in subs:
                self._walk(s, _host_of(s) or host, recursive, results, prefix)
            return
        if not sign and not subs:
            # 可能页面需要提取码或已变
            raise PanError("未能从蓝奏云页面提取 sign（页面结构可能已更新，或需要提取码）")

    def _get_page(self, url):
        code, raw, _ = http.get(url, headers={"User-Agent": BROWSER_UA})
        if code != 200 or not raw:
            raise PanError("获取蓝奏云分享页失败 (HTTP %s)" % code)
        return raw

    def _resolve_file(self, page_url, host, html, sign, results, prefix):
        form = {"action": "downprocess", "sign": sign, "ves": "1"}
        w, t = _extract_websign(html)
        if w:
            form["websign"] = w
        if t:
            form["websign_t"] = t
        code, raw, _ = http.post_form(
            "https://%s/ajaxm.php" % host, fields=form,
            headers={"User-Agent": BROWSER_UA, "Referer": "https://%s/" % host})
        data = http.parse_json(raw)
        if not data or data.get("zt") != 1:
            msg = (data or {}).get("inf") if data else raw
            raise PanError("蓝奏云取链失败: %s" % msg)
        dom = data.get("dom") or ""
        url_path = data.get("url") or ""
        name = data.get("inf") or ""
        real = _join_url(dom, url_path)
        # 二级跳转：GET real，跟随重定向或解析二级 JSON
        final = self._follow(real, host)
        results.append({
            "path": prefix + (name or real),
            "name": name or real,
            "size": 0,
            "is_dir": False,
            "url": final,
            "headers": {"Referer": "https://%s/" % host, "User-Agent": BROWSER_UA},
        })

    def _follow(self, real, host):
        try:
            import urllib.request
            req = urllib.request.Request(
                real, headers={"User-Agent": BROWSER_UA, "Referer": "https://%s/" % host})
            r = urllib.request.urlopen(req, timeout=60)
            # 跟随重定向后，最终 url 可能为 CDN 直链
            final_url = r.geturl()
            body = r.read(4096).decode("utf-8", "replace")
            r.close()
            # 若返回的是二级 JSON（部分大文件），再解析一次
            j = http.parse_json(body)
            if j and j.get("zt") == 1 and j.get("url"):
                return _join_url(j.get("dom") or "https://%s" % host, j.get("url"))
            return final_url
        except Exception:
            # 跟随失败则退回 real（部分情况下 real 本身即可用）
            return real

    def dry_run_info(self, url):
        host = _host_of(url)
        if not host:
            return "  !! 无法识别蓝奏云链接"
        return ("  1) GET %s\n  2) POST https://%s/ajaxm.php (action=downprocess)\n"
                "  3) 拼接直链并 GET（带 Referer）" % (url, host))
