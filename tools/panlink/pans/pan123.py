#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
123 云盘 provider —— 分享链接解析取直链
======================================
接口来源（多信源交叉确认 + 2026-10-23 实测探测）：
  ① alist / OpenList 的 123_share 驱动（drivers/123_share，生产在用）：
     列目录 GET  /b/api/share/get（alist 带 signPath 签名）
     取链   POST /b/api/share/download/info（body: shareKey/SharePwd/etag/fileId/s3keyFlag/size）
  ② LinkSwift（hmjz100/LinkSwift，AGPL-3.0）的 $123pan 适配器（更新的 v2 端点）：
     取链   POST https://api.123pan.cn/api/v2/share/download/info
           body {ShareKey, FileID, S3keyFlag, Size, Etag}
           直链 = dispatchList[0].prefix + downloadPath
  ③ 实测（2026-10-23，本机匿名请求）：
     - API 已从 www.123pan.com/b/api 迁到 **api.123pan.cn/b/api**（旧 host 返回 SPA 404 兜底页）
     - 列目录匿名可用：假 key 返回 {"code":5103,"message":"此分享不存在"}（非鉴权错误）
     - 取链端点匿名可用：返回 {"code":400,"message":"Etag格式异常"}（在做参数校验，非鉴权错误）
     - **signPath 签名非强校验**：带/不带签名响应完全一致，故默认不发送
       （alist 在生产中发送，保留实现备用，USE_SIGN 可一键开启）

⚠️ 成熟度：🔶 实验性（端点已实测存活，但未经真实分享全链路验证）。

关键机制：
  - **params 二次解码**：返回的 DownloadURL 若带 params 查询参数，整个 URL 要被
    params 值的 base64 解码结果替换（LinkSwift 与 alist 双源确认，最容易漏的一步）。
  - 下载需带 Referer: https://yun.123pan.com/。

所需凭据：分享解析默认匿名（123 云盘宣传"免登下载"）；个别分享若要求登录，
用 --cookie 传浏览器 Cookie 或 --token 传 authorToken（Bearer）。
"""

import base64
import binascii
import random
import re
import time
import urllib.parse
import zlib
from datetime import datetime, timedelta, timezone

from . import http
from .base import PanError, PanResolver

B_API = "https://api.123pan.cn/b/api"
V2_API = "https://api.123pan.cn/api/v2"
LIST_URL = B_API + "/share/get"
DL_URL = B_API + "/share/download/info"
DL_URL_V2 = V2_API + "/share/download/info"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
DL_REFERER = "https://yun.123pan.com/"

# signPath 签名开关：2026-10-23 实测带/不带签名响应一致（非强校验），默认关闭；
# 若 123 哪天开始强校验，改成 True 即可（签名实现保留在 sign_path）。
USE_SIGN = False

# signPath 的时区偏移（秒）。alist 源码用 83600（疑似笔误，正确东八区是 28800）；
# 仅在 USE_SIGN=True 时生效。
TZ_OFFSET = 8 * 3600

# 批量与节流（LinkSwift 同款：15/批 + 批间 sleep 1s）
BATCH = 15
BATCH_SLEEP = 1.0

# 分享链接：https://www.123pan.com/s/XXXX（也兼容 123684/123865/123952/123912 等域名）
_P123_RE = re.compile(r"(?:123pan\.com|123684\.com|123865\.com|123952\.com"
                      r"|123912\.com|123pan\.cn)/s/([A-Za-z0-9_-]+)", re.IGNORECASE)
_PWD_URL_RE = re.compile(r"[?&]pwd=([A-Za-z0-9]{4,8})")
_PWD_TEXT_RE = re.compile(r"(?:提取码|访问码|密码)[：:]\s*([A-Za-z0-9]{4,8})")

# signPath 字符映射表（alist util.go 原表：数字 0-9 → 26 个字母）
_TABLE = b"adefghlmyijnopkqrstubcvwsz"


def parse_123_link(text):
    text = (text or "").strip()
    m = re.search(r"https?://[^\s]+", text)
    if not m:
        return None, None
    url = m.group(0).rstrip("。，,；;)]}'\"")
    sid_m = _P123_RE.search(url)
    if not sid_m:
        return None, None
    share_key = sid_m.group(1)
    pwd = _PWD_URL_RE.search(url)
    pwd = pwd.group(1) if pwd else None
    if not pwd:
        t = _PWD_TEXT_RE.search(text)
        pwd = t.group(1) if t else None
    return share_key, pwd


def sign_path(path):
    """alist signPath 的 Python 重写。返回 (key, value) 查询参数对。"""
    tz = timezone(timedelta(seconds=TZ_OFFSET))
    now = datetime.now(tz)
    ts = str(int(now.timestamp()))
    rnd = str(round(1e7 * random.random()))
    # Go 原版是 table[byte-48]（字节即 ASCII 码）；Python 的 int(c) 直接就是数字值，不能再减
    mapped = bytes(_TABLE[int(c)] for c in now.strftime("%Y%m%d%H%M"))
    time_sign = str(zlib.crc32(mapped))
    data = "|".join([ts, rnd, path, "web", "3", time_sign])
    data_sign = str(zlib.crc32(data.encode("utf-8")))
    return time_sign, "%s-%s-%s" % (ts, rnd, data_sign)


def decode_params_url(url):
    """DownloadURL 带 params 时整体 base64 解码替换（双源确认的坑）。"""
    if not url:
        return url
    try:
        u = urllib.parse.urlparse(url)
        params = urllib.parse.parse_qs(u.query).get("params")
        if not params or not params[0]:
            return url
        dec = base64.b64decode(params[0] + "=" * (-len(params[0]) % 4)).decode("utf-8", "ignore")
        return dec if dec.startswith("http") else url
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return url


class Pan123Resolver(PanResolver):
    name = "123云盘"
    requires_auth = False  # 分享解析默认匿名；个别分享要求登录时传 --cookie/--token
    auth_hint = ("默认匿名解析（免登下载）；若分享要求登录，用 --cookie 传浏览器 Cookie，"
                 "或用 --token 传 authorToken（Bearer）")

    def match(self, url):
        return bool(_P123_RE.search(url or ""))

    # ---------------- 请求基础 ----------------

    def _headers(self, cookie=None, token=None, with_auth=False):
        h = {
            "User-Agent": UA,
            "Accept": "application/json, text/plain, */*",
            "Origin": "https://www.123pan.com",
            "Referer": "https://www.123pan.com/",
            "platform": "web",
            "app-version": "3",
        }
        auth = None
        if token:
            auth = token if token.lower().startswith("bearer ") else "Bearer " + token
        elif cookie:
            m = re.search(r"(?:^|;\s*)authorToken\s*=\s*([^;\s]+)", cookie)
            if m:
                auth = "Bearer " + m.group(1)
        if auth and with_auth:
            h["Authorization"] = auth
        if cookie:
            h["Cookie"] = cookie
        return h

    def _get(self, url, params, cookie=None, token=None, with_auth=False):
        """GET + JSON 解析（默认不带签名；USE_SIGN=True 时附加 signPath 签名）。"""
        q = dict(params)
        if USE_SIGN:
            k, v = sign_path(urllib.parse.urlparse(url).path)
            q[k] = v
        full = url + "?" + urllib.parse.urlencode(q)
        _, raw, _ = http.get(full, cookie, self._headers(cookie, token, with_auth))
        return http.parse_json(raw)

    # ---------------- 列目录 ----------------

    def _list_page(self, share_key, pwd, parent_id, page, cookie, token):
        data = self._get(LIST_URL, {
            "limit": "100", "next": "0", "orderBy": "file_id",
            "orderDirection": "desc", "parentFileId": parent_id,
            "Page": str(page), "shareKey": share_key, "SharePwd": pwd or "",
        }, cookie, token)
        code = (data or {}).get("code")
        if code != 0:
            msg = (data or {}).get("message") if data else "无响应"
            if code == 5103:
                raise PanError("分享不存在或已失效（code 5103）。请检查链接；"
                               "有提取码的用 --pwd 传入。")
            if code == 5112:
                raise PanError("该分享需要登录 123 云盘（code 5112）。"
                               "用 --cookie 传浏览器 Cookie 或 --token 传 authorToken。")
            if code == 5113:
                raise PanError("分享者本月免费流量不足/需会员（code 5113），"
                               "对方开通流量包或会员后才能下载。")
            raise PanError("列分享文件失败（code %s）：%s" % (code, msg))
        d = data.get("data", {}) or {}
        return d.get("InfoList") or [], str(d.get("Next", "-1"))

    def _collect(self, share_key, pwd, parent_id, prefix, recursive,
                 out, cookie, token, _depth=0):
        page = 1
        while True:
            infos, nxt = self._list_page(share_key, pwd, parent_id, page,
                                         cookie, token)
            for it in infos:
                fid = str(it.get("FileId"))
                name = it.get("FileName") or fid
                is_dir = it.get("Type") == 1
                out.append({
                    "path": prefix + name,
                    "name": name,
                    "size": int(it.get("Size") or 0),
                    "is_dir": is_dir,
                    "url": None,
                    "headers": None,
                    "_etag": it.get("Etag"),
                    "_s3flag": it.get("S3KeyFlag"),
                    "_fid": fid,
                })
                if is_dir and recursive and _depth < 20:
                    self._collect(share_key, pwd, fid,
                                  prefix + name + "/", recursive, out,
                                  cookie, token, _depth + 1)
            if len(infos) < 100 or nxt == "-1" or page >= 100:
                break
            page += 1

    # ---------------- 取直链 ----------------

    def _download_info(self, item, share_key, pwd, cookie, token):
        """优先 b/api（匿名可用）；失败且带登录态时试 v2。返回最终直链或 None。"""
        body = {
            "shareKey": share_key,
            "SharePwd": pwd or "",
            "etag": item.get("_etag"),
            "fileId": item.get("_fid"),
            "s3keyFlag": item.get("_s3flag"),
            "size": item.get("size"),
        }
        _, raw, _ = http.post_json(DL_URL, cookie, body,
                                   self._headers(cookie, token))
        data = http.parse_json(raw)
        url = None
        if data and data.get("code") == 0:
            url = ((data.get("data") or {}).get("DownloadURL")
                   or (data.get("data") or {}).get("DownloadUrl"))
        if not url and (cookie or token):
            # 备选：LinkSwift 的 v2 端点（需要登录态）
            body2 = {
                "ShareKey": share_key,
                "FileID": item.get("_fid"),
                "S3keyFlag": item.get("_s3flag"),
                "Size": item.get("size"),
                "Etag": item.get("_etag"),
            }
            h = self._headers(cookie, token, with_auth=True)
            h["LoginUuid"] = "wb-pan123"
            _, raw2, _ = http.post_json(DL_URL_V2, cookie, body2, h)
            d2 = http.parse_json(raw2)
            if d2 and d2.get("code") == 0:
                d2d = d2.get("data") or {}
                prefix = (d2d.get("dispatchList") or [{}])[0].get("prefix", "")
                url = prefix + (d2d.get("downloadPath") or "")
        if not url:
            msg = (data or {}).get("message") if data else "无响应"
            raise PanError("获取下载直链失败：%s" % msg)
        return decode_params_url(url)

    # ---------------- 主流程 ----------------

    def resolve(self, url, pwd=None, cookie=None, token=None,
                recursive=True, dry_run=False, **opts):
        share_key, link_pwd = parse_123_link(url)
        if not share_key:
            raise PanError("无法识别 123 云盘分享链接（需要 123pan.com/s/xxx 形式）")
        pwd = pwd or link_pwd

        if dry_run:
            return "(dry-run)", [{
                "path": "（dry-run 不实际解析）", "name": "", "size": 0,
                "is_dir": False, "url": None, "headers": {},
            }]

        items = []
        self._collect(share_key, pwd, "0", "", recursive, items, cookie, token)
        files = [it for it in items if not it["is_dir"]]
        if not files:
            raise PanError("分享内没有文件（可能已清空、链接失效或需提取码）")

        # 取直链：批量 15 + 批间 sleep
        results = []
        for i in range(0, len(files), BATCH):
            batch = files[i:i + BATCH]
            for it in batch:
                durl = self._download_info(it, share_key, pwd, cookie, token)
                it["url"] = durl
                it["headers"] = {"User-Agent": UA, "Referer": DL_REFERER}
                results.append(it)
            if i + BATCH < len(files):
                time.sleep(BATCH_SLEEP)
        return share_key, results

    def dry_run_info(self, url):
        share_key, pwd = parse_123_link(url)
        if not share_key:
            return "  !! 无法识别 123 云盘链接（需 123pan.com/s/xxx）"
        return (
            "  1) GET  %s?limit=100&next=0&orderBy=file_id&parentFileId=0&Page=1"
            "&shareKey=%s&SharePwd=%s\n"
            "     （2026-10-23 实测匿名可用；Type=1 为目录，递归换 parentFileId）\n"
            "  2) POST %s\n"
            "     {\"shareKey\":\"%s\",\"SharePwd\":\"%s\",\"etag\":\"<Etag>\","
            "\"fileId\":\"<FileId>\",\"s3keyFlag\":\"<S3KeyFlag>\",\"size\":<Size>}\n"
            "     （备选 v2: POST %s {ShareKey,FileID,S3keyFlag,Size,Etag}，需登录态）\n"
            "  3) 直链 = data.DownloadURL；若 URL 带 params 查询参数 → 整个 URL 换成 params 的 base64 解码值\n"
            "  下载需带 Referer: %s\n"
            "  已知错误码：5103 分享不存在/失效、5112 需登录、5113 分享者流量不足"
            % (LIST_URL, share_key, pwd or "", DL_URL, share_key, pwd or "",
               DL_URL_V2, DL_REFERER)
        )
