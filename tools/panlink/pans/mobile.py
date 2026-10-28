#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
中国移动云盘（和彩云）provider —— 分享链接解析取直链
================================================
分享态：列目录为公开接口（无需登录），取直链需登录 + 自算 mcloud-sign 签名。
参考：xujun.org 逆向复盘（已从 JS bundle 挖出接口 + 签名公式，并实测跑通 154 文件下载）
      + alist Yun139 驱动（mcloud-sign 同源）。

接口链路（分享页，已实测 HTTP 200 + 结构化 JSON {resultCode,desc,data,success}）：
  POST share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IOutLink/getOutLinkInfoV6
      body: {"getOutLinkInfoReq": {"linkID":.., "passwd":.., "pCaID":"root",
              "bNum":1, "eNum":50, "srtDr":1, "caSrt":"", "coSrt":""}}
      → data.caLst(目录: caID/caName) + data.coLst(文件: coName/coSize/path)
      ★ 列根目录 pCaID 必须是字符串 "root"（传空/-1/0 都返回空列表）
      ★ 列目录免登录 / 免签名
  POST share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IOutLink/dlFromOutLinkV3
      body: {"dlFromOutLinkReqV3": {"account":<手机号>, "linkID":.., "coIDLst":{"item":[path..]}}}
      → data.redrUrl（CDN 预签名直链，★ 仅 900 秒有效，拿到即下）
      ★ 取直链必须带登录态 Authorization + 自算 mcloud-sign（匿名返 200000401 鉴权失败）

mcloud-sign 签名（与 alist Yun139 同源，已按前端公式复刻）：
  sign = MD5( MD5( base64( sorted( encodeURIComponent(JSON紧凑) ) ) )
             + MD5( 时间串 + ":" + 16位随机串 ) ).upper()
  mcloud-sign 头 = "{时间串},{16位随机串},{sign}"
  注意：encodeURIComponent 的 safe 字符集为 ~()*!.'-；sorted 是字符级排序；JSON 必须紧凑且中文不转义。

分享链接形态：
  https://yun.139.com/w/#/share/{linkID}
  https://yun.139.com/shareweb/#/w/i/{linkID}
  https://yun.139.com/sharewap/#/m/i?{linkID}
  https://caiyun.139.com/w/i/{linkID}
  https://caiyun.139.com/m/i?{linkID}
  裸 ID： {linkID}@{pwd}
提取码：链接 #密码（link_id#pwd）、?pwd=、或 --pwd。

凭据获取（取直链用）：浏览器登录 yun.139.com → F12 → 复制 Cookie 头，需含 authorization
（大小写不敏感）；auth_token / ORCHES-I-ACCOUNT-ENCRYPT / skey 也会自动被使用。
"""

import base64
import hashlib
import json
import random
import re
import string
import time
import urllib.parse

from . import http
from .base import PanError, PanResolver, isolate, batch_throttle

LIST_URL = ("https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/"
            "IOutLink/getOutLinkInfoV6")
DL_URL = ("https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/"
          "IOutLink/dlFromOutLinkV3")
ORIGIN = "https://yun.139.com"
REFERER = "https://yun.139.com/w/"

_MOBILE_RE = re.compile(r"caiyun\.139\.com|yun\.139\.com|cloud\.139\.com", re.IGNORECASE)
_LINKID_I_RE = re.compile(r"/i[?/]([A-Za-z0-9_-]+)")
_LINKID_SHARE_RE = re.compile(r"/share/([A-Za-z0-9_-]+)")
_PWD_Q_RE = re.compile(r"[?&]pwd=([A-Za-z0-9]+)", re.IGNORECASE)
_PWD_HASH_RE = re.compile(r"#([A-Za-z0-9]{3,12})$")
_BARE_RE = re.compile(r"([A-Za-z0-9_-]{6,})@([A-Za-z0-9]+)")


def parse_mobile_link(text):
    """返回 (link_id, pwd)。识别失败返回 (None, None)。"""
    text = (text or "").strip()
    m = re.search(r"https?://[^\s]+", text)
    url = m.group(0) if m else text
    url = url.rstrip("。，,；;)]}'\"")
    if not _MOBILE_RE.search(url) and not _BARE_RE.search(url):
        return None, None

    pwd = None
    pm = _PWD_Q_RE.search(url)
    if pm:
        pwd = pm.group(1)
    hm = _PWD_HASH_RE.search(url)
    if not pwd and hm:
        pwd = hm.group(1)

    link_id = None
    im = _LINKID_I_RE.search(url)
    if im:
        link_id = im.group(1)
    if not link_id:
        sm = _LINKID_SHARE_RE.search(url)
        if sm:
            link_id = sm.group(1)
    if not link_id:
        bm = _BARE_RE.search(url)
        if bm:
            link_id = bm.group(1)
            pwd = pwd or bm.group(2)
    return link_id, pwd


# ---------------- mcloud-sign 签名 ----------------

def _md5(s):
    return hashlib.md5(s.encode("utf-8")).hexdigest()


def _rand16():
    return "".join(random.choice(string.ascii_letters + string.digits)
                   for _ in range(16))


def _encode_uri_component(s):
    # JS encodeURIComponent 保留 ~()*!.'- ；其它（含 /）照常编码
    return urllib.parse.quote(s, safe="~()*!.'-")


def build_mcloud_sign(body_obj):
    """返回 (time_str, rand16, sign)。body_obj 为请求体 dict（或 None）。"""
    c = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
    a = _rand16()
    if body_obj is not None:
        js = json.dumps(body_obj, separators=(",", ":"), ensure_ascii=False)
        s = _encode_uri_component(js)
        s = "".join(sorted(s))  # 字符级排序（对编码后的整串）
        r = _md5(base64.b64encode(s.encode("utf-8")).decode("ascii"))
    else:
        r = _md5(base64.b64encode(b"").decode("ascii"))
    sign = _md5(r + _md5(c + ":" + a)).upper()
    return c, a, sign


def _parse_cookie(cookie):
    d = {}
    if not cookie:
        return d
    for part in cookie.split(";"):
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        d[k.strip().lower()] = v.strip()
    return d


def _dl_headers(sign_tuple, cookie_dict):
    c, a, sign = sign_tuple
    h = {
        "Content-Type": "application/json;charset=UTF-8",
        "Accept": "application/json, text/plain, */*",
        "mcloud-sign": "%s,%s,%s" % (c, a, sign),
        "mcloud-client": "10702",
        "mcloud-version": "7.13.3",
        "mcloud-channel": "1000101",
        "CMS-DEVICE": "default",
        "Origin": ORIGIN,
        "Referer": REFERER,
    }
    if cookie_dict.get("authorization"):
        h["Authorization"] = cookie_dict["authorization"]
    if cookie_dict.get("auth_token"):
        h["x-m4c-token"] = cookie_dict["auth_token"]
    if cookie_dict.get("orches-i-account-encrypt"):
        h["x-m4c-account"] = cookie_dict["orches-i-account-encrypt"]
    if cookie_dict.get("skey"):
        h["mcloud-skey"] = cookie_dict["skey"]
    return h


def _b64_decode_safe(v):
    if not v:
        return ""
    v = v.strip()
    v += "=" * (-len(v) % 4)
    try:
        return base64.b64decode(v).decode("utf-8", "ignore")
    except Exception:
        return ""


def _account_from_cookie(cookie_dict):
    s = _b64_decode_safe(cookie_dict.get("orches-i-account-encrypt", ""))
    if s and s.isdigit():
        return s
    return ""


def _find_redr_url(data):
    """在响应 data 中递归查找 redrUrl。"""
    if isinstance(data, dict):
        if "redrUrl" in data and data["redrUrl"]:
            return data["redrUrl"]
        for v in data.values():
            r = _find_redr_url(v)
            if r:
                return r
    elif isinstance(data, list):
        for v in data:
            r = _find_redr_url(v)
            if r:
                return r
    return None


class MobileResolver(PanResolver):
    name = "中国移动云盘"
    requires_auth = True
    auth_hint = ("取直链需登录态 Cookie（含 authorization）；列目录本身无需登录，但本工具目标是取链，故需登录")
    link_ttl = 900  # 移动 redrUrl 仅 900 秒有效，缓存 TTL 与直链寿命对齐

    def match(self, url):
        return bool(_MOBILE_RE.search(url or "")) or bool(_BARE_RE.search(url or ""))

    # ---------------- 列目录（免登录） ----------------

    def _list_page(self, link_id, pwd, pcaid, b_num, e_num):
        body = {"getOutLinkInfoReq": {
            "linkID": link_id, "passwd": pwd or "", "pCaID": pcaid,
            "bNum": b_num, "eNum": e_num, "srtDr": 1, "caSrt": "", "coSrt": "",
        }}
        code, raw, _ = http.post_json(LIST_URL, body=body, headers={
            "Content-Type": "application/json", "Origin": ORIGIN})
        data = http.parse_json(raw)
        if not data or data.get("data") is None:
            desc = data.get("desc") if data else raw
            rc = data.get("resultCode") if data else ""
            if "外链不存在" in str(desc) or "已取消" in str(desc) or rc == "200000727":
                raise PanError("分享不存在或已被取消（resultCode=%s）。请检查分享链接。" % rc)
            if "提取码" in str(desc):
                raise PanError("提取码错误（%s）。请检查 --pwd。" % desc)
            raise PanError("列出分享文件失败（resultCode=%s）：%s" % (rc, desc))
        return data["data"] or {}

    def _collect(self, link_id, pwd, pcaid, prefix, recursive, out):
        page_size = 200
        b = 1
        while True:
            d = self._list_page(link_id, pwd, pcaid, b, b + page_size - 1)
            ca_lst = d.get("caLst") or []
            co_lst = d.get("coLst") or []
            for c in ca_lst:
                name = c.get("caName") or ""
                cid = c.get("caID")
                out.append({
                    "path": (prefix + name) if name else name,
                    "name": name, "size": 0, "is_dir": True,
                    "url": None, "headers": None, "_ca_id": cid, "_path": None,
                })
                if recursive and cid:
                    self._collect(link_id, pwd, cid,
                                  (prefix + name + "/") if name else prefix,
                                  recursive, out)
            for c in co_lst:
                name = c.get("coName") or ""
                size = int(c.get("coSize") or 0)
                fpath = c.get("path")
                out.append({
                    "path": (prefix + name) if name else name,
                    "name": name, "size": size, "is_dir": False,
                    "url": None, "headers": None, "_ca_id": None, "_path": fpath,
                })
            if len(co_lst) < page_size:
                break
            b += page_size
            if b > 100000:  # 安全上限
                break

    # ---------------- 取直链（需登录 + 签名） ----------------

    def _download_link(self, link_id, pwd, fpath, cookie_dict):
        account = _account_from_cookie(cookie_dict)
        body = {"dlFromOutLinkReqV3": {
            "account": account, "linkID": link_id,
            "coIDLst": {"item": [fpath]},
        }}
        c, a, sign = build_mcloud_sign(body)
        code, raw, _ = http.post_json(DL_URL, body=body,
                                      headers=_dl_headers((c, a, sign), cookie_dict))
        data = http.parse_json(raw)
        if not data or data.get("data") is None:
            desc = data.get("desc") if data else raw
            rc = data.get("resultCode") if data else ""
            if rc == "200000401" or "鉴权失败" in str(desc):
                raise PanError("取直链失败：未登录或登录态失效（resultCode=200000401）。"
                               "请确认 --cookie 内含有效的 authorization。")
            raise PanError("取直链失败（resultCode=%s）：%s" % (rc, desc))
        redr = _find_redr_url(data["data"])
        if not redr:
            raise PanError("取直链失败：响应未返回 redrUrl（data=%s）" % json.dumps(
                data["data"], ensure_ascii=False)[:200])
        headers = {"User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                                  "Chrome/110.0.0.0 Safari/537.36"),
                   "Referer": REFERER}
        ck = cookie_dict.get("authorization")
        if ck:
            headers["Authorization"] = ck
        return redr, headers

    # ---------------- 统一入口 ----------------

    def resolve(self, url, pwd=None, cookie=None, token=None,
                recursive=True, dry_run=False, **opts):
        link_id, link_pwd = parse_mobile_link(url)
        if not link_id:
            raise PanError("无法识别中国移动云盘分享链接"
                           "（需 yun.139.com/caiyun.139.com 的分享链接，或裸 ID）")
        pwd = pwd or link_pwd

        if dry_run:
            return "(dry-run)", [{
                "path": "（dry-run 不实际解析）", "name": "", "size": 0,
                "is_dir": False, "url": None, "headers": {},
            }]

        cookie_dict = _parse_cookie(cookie)
        if not cookie_dict.get("authorization"):
            raise PanError(
                "中国移动云盘取直链需登录态 Cookie（--cookie，需含 authorization）。\n"
                "获取：浏览器登录 yun.139.com → F12 → 复制任意请求的 Cookie 头。\n"
                "（注：列目录本身无需登录；但本工具目标是取下载直链，直链接口强制登录。）")

        # 1) 递归列目录（免登录）
        items = []
        self._collect(link_id, pwd, "root", "", recursive, items)
        if not items:
            raise PanError("分享内没有文件（可能已清空、链接失效或需提取码）")

        # 2) 逐文件取直链（需登录 + 签名；单文件失败不中断整批；15/批 + 批间 1s 节流）
        files = [it for it in items if not it["is_dir"] and it.get("_path")]
        for i in range(0, len(files), 15):
            for it in files[i:i + 15]:
                res, err = isolate(
                    self._download_link, link_id, pwd, it["_path"], cookie_dict)
                if err:
                    it["error"] = err
                    continue
                it["url"], it["headers"] = res
            batch_throttle(i, 15, len(files))
        return link_id, items

    def dry_run_info(self, url):
        link_id, pwd = parse_mobile_link(url)
        if not link_id:
            return ("  !! 无法识别中国移动云盘分享链接"
                    "（需 yun.139.com/caiyun.139.com 分享链接，或裸 ID）")
        return (
            "  1) POST %s\n"
            "     body: {\"getOutLinkInfoReq\":{\"linkID\":\"%s\",\"passwd\":\"%s\","
            "\"pCaID\":\"root\",\"bNum\":1,\"eNum\":200,...}}\n"
            "     （列目录：公开接口，免登录/免签名；data.caLst=目录, data.coLst=文件；"
            "pCaID=目录caID，根目录必传\"root\"）\n"
            "  2) POST %s\n"
            "     body: {\"dlFromOutLinkReqV3\":{\"account\":\"<手机号>\",\"linkID\":\"%s\","
            "\"coIDLst\":{\"item\":[\"<文件path>\"]}}}\n"
            "     头: mcloud-sign = MD5(MD5(base64(sorted(encodeURIComponent(JSON紧凑))))"
            "+MD5(时间串:随机16)).upper()  + Authorization(<登录cookie>)\n"
            "     → data.redrUrl 即下载直链（★ 仅 900 秒有效，拿到即下）\n"
            "  取直链需登录态 Cookie（含 authorization）+ 自算 mcloud-sign\n"
            % (LIST_URL, link_id, pwd or "", DL_URL, link_id)
        )
