#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
聚合搜索后端（纯标准库）
- 采集源格式：Apple CMS V10 风格接口（/api.php/provide/vod/?ac=videolist&wd=关键词）
- 只做「客户端」：不预置任何源，源由用户自己在 sources.json / 界面里填
- 带 SSRF 防护（拒绝内网/回环/保留地址，DNS 解析后再校验）
- m3u8 代理 + 播放列表改写（把分片/密钥 URL 指回本机代理，绕开跨域）
"""
import base64
import ipaddress
import json
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = os.path.dirname(os.path.abspath(__file__))
SOURCES_FILE = os.path.join(BASE, "sources.json")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) LocalCinema/2.0"
MAX_BYTES = 8 * 1024 * 1024
_LOCK = threading.Lock()
_CACHE = {}          # key -> (expire_ts, value)
CACHE_TTL = 300


# ----------------------------------------------------------------- 源配置
def load_sources():
    if not os.path.isfile(SOURCES_FILE):
        save_sources([])
        return []
    try:
        with open(SOURCES_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict):
            d = d.get("sources", [])
        out = []
        for s in d:
            if isinstance(s, dict) and s.get("api"):
                out.append({
                    "name": str(s.get("name") or s["api"])[:40],
                    "api": str(s["api"]).strip(),
                    "enabled": bool(s.get("enabled", True)),
                })
        return out
    except Exception:
        return []


def save_sources(sources):
    data = {"sources": sources}
    tmp = SOURCES_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, SOURCES_FILE)
    _CACHE.clear()


# ----------------------------------------------------------------- 安全校验
def _is_private_host(host):
    if not host:
        return True
    h = host.strip("[]").lower()
    if h in ("localhost", "0.0.0.0") or h.endswith(".local") or h.endswith(".internal"):
        return True
    try:
        infos = socket.getaddrinfo(h, None)
    except OSError:
        return True          # 解析不了就不放行
    for info in infos:
        ip = info[4][0]
        try:
            a = ipaddress.ip_address(ip)
        except ValueError:
            return True
        if (a.is_private or a.is_loopback or a.is_link_local or a.is_reserved
                or a.is_multicast or a.is_unspecified):
            return True
    return False


def safe_url(u, allow_private=False):
    """只放行 http/https 公网地址；返回规范化 URL 或 None。"""
    try:
        p = urllib.parse.urlparse(u.strip())
    except Exception:
        return None
    if p.scheme not in ("http", "https") or not p.netloc:
        return None
    if not allow_private and _is_private_host(p.hostname):
        return None
    return u.strip()


# ----------------------------------------------------------------- HTTP
def http_get(url, timeout=10, max_bytes=MAX_BYTES, headers=None):
    h = {"User-Agent": UA, "Accept": "*/*", "Accept-Language": "zh-CN,zh;q=0.9"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        ctype = r.headers.get("Content-Type", "") or ""
        data = r.read(max_bytes)
        final = r.geturl() or url
    return ctype, data, final


def _cache_get(key):
    with _LOCK:
        v = _CACHE.get(key)
    if v and v[0] > time.time():
        return v[1]
    return None


def _cache_put(key, val, ttl=CACHE_TTL):
    with _LOCK:
        _CACHE[key] = (time.time() + ttl, val)


# ----------------------------------------------------------------- 采集接口
def _api_url(api, params):
    sep = "&" if "?" in api else "?"
    return api + sep + urllib.parse.urlencode(params)


def _parse_vod(data, base_api):
    """解析 Apple CMS 返回；JSON 优先，其次兜底 XML。"""
    text = data.decode("utf-8", "ignore").strip()
    if not text:
        return []
    try:
        j = json.loads(text)
    except Exception:
        j = None
    if isinstance(j, dict):
        lst = j.get("list") or []
        out = []
        for it in lst:
            if not isinstance(it, dict):
                continue
            out.append({
                "id": str(it.get("vod_id", "")),
                "name": str(it.get("vod_name", "")).strip(),
                "pic": str(it.get("vod_pic", "") or ""),
                "note": str(it.get("vod_remarks", "") or ""),
                "year": str(it.get("vod_year", "") or ""),
                "type": str(it.get("type_name", "") or ""),
                "play_url": str(it.get("vod_play_url", "") or ""),
            })
        return out
    # XML 兜底
    try:
        import xml.etree.ElementTree as ET
        root = ET.fromstring(text)
        out = []
        for v in root.iter("video"):
            g = lambda k: (v.findtext(k) or "").strip()
            out.append({
                "id": g("id"), "name": g("name"), "pic": "",
                "note": g("note"), "year": g("year"), "type": g("type"),
                "play_url": g("des"),
            })
        return out
    except Exception:
        return []


def search(wd, page=1, per_timeout=8):
    """并行搜索所有启用的源，按片名+年份合并去重。"""
    srcs = [s for s in load_sources() if s.get("enabled", True)]
    if not srcs:
        return {"items": [], "errors": [], "sources": 0}

    def one(s):
        url = _api_url(s["api"], {"ac": "videolist", "wd": wd, "pg": page})
        try:
            ctype, data, _ = http_get(url, timeout=per_timeout)
            return s["name"], _parse_vod(data, s["api"]), None
        except Exception as e:
            return s["name"], [], f"{s['name']}: {type(e).__name__}"

    merged, errors, order = {}, [], []
    with ThreadPoolExecutor(max_workers=min(8, len(srcs))) as ex:
        for name, items, err in ex.map(one, srcs):
            if err:
                errors.append(err)
                continue
            for it in items:
                if not it["name"] or not it["id"]:
                    continue
                key = (it["name"].lower(), it["year"])
                if key in merged:
                    merged[key]["from"].append({"source": name, "id": it["id"]})
                else:
                    merged[key] = {
                        "name": it["name"], "pic": it["pic"], "note": it["note"],
                        "year": it["year"], "type": it["type"],
                        "from": [{"source": name, "id": it["id"]}],
                    }
                    order.append(key)
    items = [merged[k] for k in order][:80]
    return {"items": items, "errors": errors, "sources": len(srcs)}


def detail(source_name, vod_id):
    """取详情 + 剧集列表。返回 {'name','pic','episodes':[{name,url}]}"""
    srcs = {s["name"]: s for s in load_sources()}
    s = srcs.get(source_name)
    if not s:
        return None
    url = _api_url(s["api"], {"ac": "videolist", "ids": vod_id})
    ctype, data, _ = http_get(url, timeout=12)
    lst = _parse_vod(data, s["api"])
    if not lst:
        # 部分源只认 ac=detail
        url2 = _api_url(s["api"], {"ac": "detail", "ids": vod_id})
        ctype, data, _ = http_get(url2, timeout=12)
        lst = _parse_vod(data, s["api"])
    if not lst:
        return None
    v = lst[0]
    eps = parse_play_url(v.get("play_url", ""))
    return {"name": v["name"], "pic": v["pic"], "episodes": eps,
            "note": v["note"], "year": v["year"]}


def parse_play_url(play_url):
    """vod_play_url 形如：第01集$http://a.m3u8#第02集$http://b.m3u8"""
    eps = []
    if not play_url:
        return eps
    # 去掉多播放源前缀（如 "ffm3u8$$$"）
    for chunk in play_url.split("$$$"):
        for seg in chunk.split("#"):
            seg = seg.strip()
            if not seg or "$" not in seg:
                continue
            name, _, url = seg.partition("$")
            url = url.strip()
            if not url.lower().startswith(("http://", "https://")):
                continue
            eps.append({"name": name.strip()[:40] or f"第{len(eps)+1}集", "url": url})
        if eps:
            break       # 只用第一个可用的播放线路
    return eps


# ----------------------------------------------------------------- 代理
def b64e(s):
    return base64.urlsafe_b64encode(s.encode("utf-8")).decode("ascii").rstrip("=")


def b64d(s):
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad).decode("utf-8", "ignore")


def proxy_path(url):
    return "/api/agg/proxy?u=" + b64e(url)


def rewrite_m3u8(text, base_url):
    """把播放列表里的分片/密钥地址改成走本机代理，并补成绝对地址。"""
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            s = re.sub(r'URI="([^"]+)"',
                       lambda m: 'URI="%s"' % proxy_path(urllib.parse.urljoin(base_url, m.group(1))),
                       s)
            out.append(s)
        else:
            out.append(proxy_path(urllib.parse.urljoin(base_url, s)))
    return "\n".join(out)


def fetch_for_proxy(raw_url):
    """返回 (content_type, body_bytes)；m3u8 会被改写。"""
    url = safe_url(raw_url, allow_private=False)
    if not url:
        raise ValueError("URL 不被允许（仅支持公网 http/https）")
    ctype, data, final_url = http_get(url, timeout=20)
    head = data[:7].lstrip()
    is_m3u8 = ("mpegurl" in ctype.lower()) or head.startswith(b"#EXTM3U")
    if is_m3u8:
        txt = data.decode("utf-8", "ignore")
        return "application/vnd.apple.mpegurl", rewrite_m3u8(txt, final_url).encode("utf-8")
    return (ctype or "application/octet-stream"), data


# ----------------------------------------------------------------- 源清单导入
# 支持三种格式：
#   1) LibreTV-SourceList：{"sources":[{name,url|api,detail}], "liveSources":[...]}
#   2) TVBOX 配置：{"sites":[{key,name,type,api}], "lives":[...], "parses":[...]}
#   3) 纯文本：一行一个接口地址
def fetch_text(url):
    """拉取订阅地址内容（允许内网，方便用户自建）。"""
    u = safe_url(url, allow_private=True)
    if not u:
        raise ValueError("订阅地址不合法（需要 http/https）")
    _ctype, data, _final = http_get(u, timeout=20)
    return data.decode("utf-8", "ignore")


def _host_of(u):
    try:
        return urllib.parse.urlparse(u).hostname or u
    except Exception:
        return u


def parse_source_text(text):
    """把 LibreTV / TVBOX / 纯列表 解析成统一候选源列表。"""
    text = (text or "").strip()
    if not text:
        raise ValueError("内容为空")

    raw, live, skipped, fmt = [], 0, 0, "list"
    try:
        data = json.loads(text)
    except Exception:
        data = None

    if data is None:
        for ln in text.splitlines():
            ln = ln.strip()
            if not ln or ln.startswith("#"):
                continue
            raw.append({"api": ln})
    elif isinstance(data, list):
        raw = data
    elif isinstance(data, dict):
        if isinstance(data.get("sources"), list):
            fmt = "libretv"
            raw += [x for x in data["sources"] if isinstance(x, dict)]
        if isinstance(data.get("sites"), list):
            fmt = "tvbox" if fmt == "list" else fmt
            for s in data["sites"]:
                if not isinstance(s, dict):
                    continue
                t, api = s.get("type"), str(s.get("api") or "").strip()
                if isinstance(t, int) and t not in (0, 1, 4):
                    skipped += 1          # type=3 是 spider，需要 TVBOX 自己的引擎
                    continue
                if not api.lower().startswith("http"):
                    skipped += 1
                    continue
                raw.append({"name": s.get("name") or s.get("key"), "api": api})
        if isinstance(data.get("api_site"), dict):     # 老版 TVBOX
            for k, s in data["api_site"].items():
                if isinstance(s, dict) and str(s.get("api") or "").startswith("http"):
                    raw.append({"name": s.get("name") or k, "api": s.get("api")})
        for key in ("liveSources", "lives", "urls"):
            if isinstance(data.get(key), list):
                live += len(data[key])
    else:
        raise ValueError("看不懂这个格式")

    out, seen = [], set()
    for it in raw:
        if not isinstance(it, dict):
            it = {"api": str(it)}
        api = str(it.get("api") or it.get("url") or "").strip()
        if not api.lower().startswith("http"):
            skipped += 1
            continue
        norm = safe_url(api, allow_private=True)
        if not norm or norm in seen:
            if not norm:
                skipped += 1
            continue
        seen.add(norm)
        nm = str(it.get("name") or it.get("key") or "").strip() or _host_of(norm)
        out.append({"name": nm[:40], "api": norm})

    return {"format": fmt, "candidates": out, "live": live, "skipped": skipped}


def merge_sources(existing, new_items):
    """按 api 去重合并（不覆盖已有源的启用状态）。"""
    seen = {s.get("api") for s in existing}
    added = 0
    out = list(existing)
    for s in new_items:
        api = s.get("api")
        if not api or api in seen:
            continue
        seen.add(api)
        out.append({"name": s.get("name") or _host_of(api), "api": api, "enabled": True})
        added += 1
    return out, added
