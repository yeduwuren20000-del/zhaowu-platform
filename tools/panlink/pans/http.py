#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
零依赖 HTTP 封装（仅 urllib / json），供所有 provider 复用。
统一返回 (code, raw_text, set_cookies)。
"""

import json
import re
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def _build_request(url, method="GET", cookie=None, body=None, headers=None):
    h = {"User-Agent": DEFAULT_UA}
    if cookie:
        h["Cookie"] = cookie
    if headers:
        h.update(headers)
    data = None
    if body is not None:
        if isinstance(body, (dict, list)):
            h["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        else:
            data = body.encode("utf-8") if isinstance(body, str) else body
    return urllib.request.Request(url, data=data, headers=h, method=method)


def request(method, url, cookie=None, body=None, headers=None, timeout=30):
    """返回 (code, raw_text, set_cookies)。网络层错误原样抛出，由调用方处理。"""
    req = _build_request(url, method, cookie, body, headers)
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        code = resp.getcode()
        raw = resp.read().decode("utf-8", "replace")
        set_cookies = resp.headers.get_all("Set-Cookie") or []
        resp.close()
    except urllib.error.HTTPError as e:
        code = e.code
        raw = e.read().decode("utf-8", "replace")
        set_cookies = e.headers.get_all("Set-Cookie") or []
    return code, raw, set_cookies


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """禁止自动跟随重定向：把 3xx 当普通响应返回，便于调用方读取 Location。
    （百度 OAuth 的 access_token 在重定向 URL 的 fragment 里，自动跟随会丢失。）"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_no_redirect_opener = urllib.request.build_opener(_NoRedirect)


def request_no_redirect(method, url, cookie=None, body=None, headers=None,
                        timeout=30):
    """不跟随重定向的请求。返回 (code, raw_text, location, all_headers)。
    location 为 3xx 时的 Location 头（可能为 None）；all_headers 是响应头对象。"""
    req = _build_request(url, method, cookie, body, headers)
    try:
        resp = _no_redirect_opener.open(req, timeout=timeout)
        code = resp.getcode()
        raw = resp.read().decode("utf-8", "replace")
        location = resp.headers.get("Location")
        resp.close()
        return code, raw, location, resp.headers
    except urllib.error.HTTPError as e:
        code = e.code
        raw = e.read().decode("utf-8", "replace")
        location = e.headers.get("Location")
        return code, raw, location, e.headers


def get(url, cookie=None, headers=None, timeout=30):
    return request("GET", url, cookie, None, headers, timeout)


def post_json(url, cookie=None, body=None, headers=None, timeout=30):
    h = dict(headers or {})
    return request("POST", url, cookie, body, h, timeout)


def post_form(url, cookie=None, fields=None, headers=None, timeout=30):
    """表单提交（application/x-www-form-urlencoded）。"""
    h = dict(headers or {})
    h["Content-Type"] = "application/x-www-form-urlencoded"
    data = urllib.parse.urlencode(fields or {})
    return request("POST", url, cookie, data, h, timeout)


def parse_json(raw):
    try:
        return json.loads(raw)
    except Exception:
        return None


def stream_get(url, headers=None, timeout=60):
    """返回一个可读的响应对象（用于大文件流式下载）。"""
    req = _build_request(url, "GET", None, None, headers)
    return urllib.request.urlopen(req, timeout=timeout)


def stream_get_range(url, start, headers=None, timeout=60):
    """从 start 字节请求到末尾（``bytes=start-``），用于断点续传。
    调用方必须检查响应码：206 才是真的续传上了，200 表示服务端忽略
    Range 而返回全量，此时应从 0 重写而不是追加。"""
    h = dict(headers or {})
    h["Range"] = "bytes=%d-" % start
    req = _build_request(url, "GET", None, None, h)
    return urllib.request.urlopen(req, timeout=timeout)


def open_range(url, start, end, headers=None, timeout=120):
    """打开一个 Range 请求（bytes=start-end，闭区间），返回响应对象。
    调用方负责 read/close。用于多线程分块下载。"""
    h = dict(headers or {})
    h["Range"] = "bytes=%d-%d" % (start, end)
    req = _build_request(url, "GET", None, None, h)
    return urllib.request.urlopen(req, timeout=timeout)


def probe_range(url, headers=None, timeout=30):
    """探测服务端是否支持 Range 分块下载。
    返回 {"ok": bool, "total": int|None, "status": int}。
    ok=True 需同时满足：返回 206 且 Content-Range 可解析出总大小。"""
    try:
        resp = open_range(url, 0, 0, headers, timeout)
    except urllib.error.HTTPError as e:
        return {"ok": False, "total": None, "status": e.code}
    except Exception:
        return {"ok": False, "total": None, "status": 0}
    try:
        status = resp.getcode()
        cr = resp.headers.get("Content-Range") or ""
        m = re.search(r"/(\d+)\s*$", cr)
        total = int(m.group(1)) if m else None
        return {"ok": (status == 206 and total is not None),
                "total": total, "status": status}
    finally:
        resp.close()
