#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
解析结果磁盘缓存（直链 TTL 缓存）
================================
借鉴 LinkSwift 的直链缓存思路：「解析分享 → 列文件 → 取直链」是风控敏感操作，
重复解析同一分享既慢又容易触发频控。按网盘 TTL 缓存 (title, files)，
命中即复用，跳过全部网络请求。

设计（零依赖、可回滚、失败静默）：
- 存储：单个 JSON 文件，默认 `~/.cache/yunx-pans/links.json`
  （可用环境变量 YUNX_CACHE_DIR 覆盖，测试/便携场景用）；
- key：sha1(网盘 + URL + 提取码 + cookie 摘要)——登录态变化自动失效；
- value：{title, files, expires_at, created_at}；
- TTL：由 resolver 的 `link_ttl` 类属性（秒）决定，未设置用 DEFAULT_TTL；
- 原子写（tmp + os.replace），写失败/读损坏一律静默禁用，绝不影响主流程；
- 体积控制：读取时清理过期项；超过 MAX_ENTRIES 淘汰最旧。

⚠️ 安全说明：files 里的 headers 可能含 Cookie / Authorization（缓存命中后
下载要用），因此缓存文件按「本机单用户敏感数据」对待，存放在用户目录下。
"""

import hashlib
import json
import os
import tempfile
import time

DEFAULT_TTL = 1800          # 默认 30 分钟
MAX_ENTRIES = 200           # 缓存条目上限，超出淘汰最旧
CACHE_VERSION = 1           # 结构版本，变更结构时 +1 使旧缓存自动失效


def _cache_dir():
    d = os.environ.get("YUNX_CACHE_DIR")
    if d:
        return d
    return os.path.join(os.path.expanduser("~"), ".cache", "yunx-pans")


def _cache_path():
    return os.path.join(_cache_dir(), "links.json")


def make_key(pan_name, url, pwd=None, cookie=None):
    """生成缓存 key。同分享+同登录态 → 同 key；cookie 变化 → key 变化。"""
    cookie_digest = hashlib.sha1((cookie or "").encode("utf-8")).hexdigest()
    raw = "%s\n%s\n%s\n%s\nv%d" % (pan_name or "", url or "",
                                   pwd or "", cookie_digest, CACHE_VERSION)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _load_raw():
    """读取缓存文件；不存在/损坏/为空都返回 {}（绝不抛异常）。"""
    path = _cache_path()
    try:
        with open(path, "r", encoding="utf-8") as fp:
            data = json.load(fp)
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    # 结构版本不一致 → 整体视为无缓存
    if data.get("version") != CACHE_VERSION:
        return {}
    entries = data.get("entries")
    if not isinstance(entries, dict):
        return {}
    return entries


def _save_raw(entries):
    """原子写缓存文件；失败静默返回 False。"""
    path = _cache_path()
    try:
        os.makedirs(_cache_dir(), exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".links-", suffix=".tmp",
                                   dir=_cache_dir())
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fp:
                json.dump({"version": CACHE_VERSION, "entries": entries},
                          fp, ensure_ascii=False)
            os.replace(tmp, path)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        return True
    except Exception:
        return False


def _gc(entries, now=None):
    """清理过期项 + 超上限淘汰最旧。返回保留的 entries。"""
    now = now if now is not None else time.time()
    alive = {k: v for k, v in entries.items()
             if isinstance(v, dict) and v.get("expires_at", 0) > now}
    if len(alive) > MAX_ENTRIES:
        # 按 created_at 升序，砍掉最旧的，保留较新 MAX_ENTRIES 条
        keep = sorted(alive.items(),
                      key=lambda kv: kv[1].get("created_at", 0))[-MAX_ENTRIES:]
        alive = dict(keep)
    return alive


def get(key):
    """取缓存条目；未命中/已过期返回 None。命中不做续期。"""
    entries = _load_raw()
    now = time.time()
    if key not in entries:
        return None
    entry = entries[key]
    if not isinstance(entry, dict) or entry.get("expires_at", 0) <= now:
        return None
    return entry


def put(key, title, files, ttl=DEFAULT_TTL):
    """写入缓存（原子写 + GC）。失败静默返回 False。"""
    entries = _load_raw()
    now = time.time()
    entries[key] = {
        "title": title,
        "files": files,
        "expires_at": now + max(0, ttl),
        "created_at": now,
    }
    entries = _gc(entries, now)
    return _save_raw(entries)


def clear():
    """清空缓存文件。返回是否真的删掉了文件。"""
    path = _cache_path()
    try:
        if os.path.exists(path):
            os.unlink(path)
            return True
    except OSError:
        pass
    return False


def stats():
    """返回 (有效条目数, 缓存文件大小 bytes)，供 --cache-stats 展示。"""
    entries = _gc(_load_raw())
    path = _cache_path()
    try:
        size = os.path.getsize(path) if os.path.exists(path) else 0
    except OSError:
        size = 0
    return len(entries), size
