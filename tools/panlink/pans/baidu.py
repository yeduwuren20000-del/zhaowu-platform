#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
百度网盘 provider —— 分享链接解析取直链（2026 现行机制）
================================================
参考 baiduwp-php（yuantu666/birdxs，AGPL-3.0）的接口逆向实现。
策略：免转存分享取链（登录态，不需先把文件转存到自己的网盘）。

⚠️ 重要：百度已在近年改了机制，旧端点已失效：
  - 旧：本地 md5 算 sign + api/share/list（现已 404）+ share/token
  - 新：sign/timestamp 由服务端 share/tplconfig 下发（5 分钟有效）
       列文件走 share/wxlist（POST）
       取直链走 api/sharedownload（sign/timestamp 来自 tplconfig，randsk 来自 wxlist 的 seckey）
  本实现按【新机制】编写。

接口链路（抓包自 pan.baidu.com 网页端，对照 baiduwp-php）：
  GET  pan.baidu.com/share/tplconfig        → 拿 sign + timestamp（服务端下发，非本地计算）
  POST pan.baidu.com/share/wxlist           → 列分享文件（递归走 dir 参数）；响应含 seckey→randsk、shareid、uk
  POST pan.baidu.com/api/sharedownload      → 取下载直链（sign/timestamp 来自 tplconfig，sekey=randsk）

所需凭据：百度登录态 Cookie（含 BDUSS），从浏览器
F12 → Network → 复制任意 pan.baidu.com 请求的 Cookie 头即可。
分享若设了提取码，用 --pwd 传入。

AccessToken（2026-10-23 增）：在 BDUSS 之外 best-effort 走 OAuth 隐式授权
拿 access_token 并附加到 dlink（大文件直链校验 + 百度收紧 BDUSS 的后路；
流程移植自 LinkSwift v1.1.1.6+ 的 $baidu.getToken，失败静默回退老路径）。

注意：免费账号取到的 dlink 会被百度限速（服务端策略，非本工具问题）；dlink 有效期约 8 小时。
"""

import base64
import re
import urllib.parse

from . import http
from .base import PanError, PanResolver, isolate, batch_throttle

APP_ID = "250528"
TPLCONFIG_URL = "https://pan.baidu.com/share/tplconfig"
WXLIST_URL = "https://pan.baidu.com/share/wxlist?channel=weixin&version=2.2.2&clienttype=25&web=1"
DOWNLOAD_URL = ("https://pan.baidu.com/api/sharedownload?app_id=%s&channel=chunlei"
                "&clienttype=12&sign=%%s&timestamp=%%s&web=1" % APP_ID)
# OAuth2 隐式授权页（LinkSwift v1.1.1.6+ 同款：废弃纯 BDUSS 鉴权，改用 AccessToken）。
# client_id 来自 OpenList（baiduwp 生态常用）；redirect_uri=oob 时 token 在重定向
# URL 的 fragment 里，必须用不跟随重定向的请求读取（见 http.request_no_redirect）。
AUTHORIZE_URL = ("https://openapi.baidu.com/oauth/2.0/authorize"
                 "?response_type=token&scope=basic,netdisk"
                 "&client_id=omiOnr2tYnN9vSyDErcVFWpPU2mZA7YO"
                 "&redirect_uri=oob&confirm_login=0")

UA_TPL = "netdisk;pan.baidu.com"
UA_NETDISK = "netdisk"
UA_BROWSER = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36 Edg/110.0.1587.69")
REFERER = "https://pan.baidu.com/disk/home"

# 分享链接：
#   https://pan.baidu.com/s/1AbCdEf...        → surl = 1AbCdEf...（长码，以 1 开头）
#   https://pan.baidu.com/share/init?surl=AbC → surl = AbC（短码）
#   https://pan.baidu.com/share/init?surl=2XX  → 2 开头是 uk&shareid 的 base64（罕见）
_BAIDU_LONG_RE = re.compile(r"pan\.baidu\.com/s/([A-Za-z0-9_-]+)", re.IGNORECASE)
_BAIDU_SURL_RE = re.compile(r"[?&]surl=([A-Za-z0-9_-]+)")
_PWD_RE = re.compile(r"[?&]pwd=([A-Za-z0-9]+)")


def parse_baidu_link(text):
    text = (text or "").strip()
    m = re.search(r"https?://[^\s]+", text)
    if not m:
        return None, None, None
    url = m.group(0).rstrip("。，,；;)]}'\"")
    long_m = _BAIDU_LONG_RE.search(url)
    if long_m:
        surl = long_m.group(1)
    else:
        s = _BAIDU_SURL_RE.search(url)
        surl = s.group(1) if s else None
    if not surl:
        return None, None, None
    pwd = _PWD_RE.search(url)
    pwd = pwd.group(1) if pwd else None
    # 2 开头：uk&shareid 的 base64
    uk = shareid = None
    if surl.startswith("2"):
        try:
            dec = base64.b64decode(surl[1:]).decode("utf-8", "ignore")
            uk, shareid = dec.split("&")[:2]
            surl = ""
        except Exception:
            uk = shareid = None
    return surl, pwd, (uk, shareid)


def _decode_seckey(seckey):
    """baiduwp 的 decodeSceKey：把 seckey 还原成 randsk。"""
    if not seckey:
        return ""
    s = seckey.replace("-", "+").replace("~", "=").replace("_", "/")
    if "%" in s:
        s = urllib.parse.unquote(s)
    return s


def _token_from_url(url):
    """从授权重定向 URL 的 fragment 提取 access_token（oob#access_token=xxx&...）。"""
    m = re.search(r"[#&]access_token=([^&#]+)", url or "")
    return m.group(1) if m else None


class BaiduResolver(PanResolver):
    name = "百度网盘"
    requires_auth = True
    auth_hint = "需 --cookie（含 BDUSS 的登录态）；分享有提取码加 --pwd"
    link_ttl = 14400  # 百度直链有效期约 8 小时，保守取 4 小时

    def __init__(self):
        self._access_token = None

    def match(self, url):
        return "pan.baidu.com" in (url or "")

    # ---------------- OAuth AccessToken（BDUSS 之外的现代鉴权）----------------

    def _get_access_token(self, cookie):
        """三段式 OAuth 隐式授权（LinkSwift $baidu.getToken 同款流程）：
          1) GET 授权页（带登录 Cookie）——已授权过则重定向 URL 直接带 access_token；
          2) 未授权则从授权页 HTML 提取 bdstoken / client_id 隐藏域，
             POST 授权表单（代替用户点“允许”按钮）；
          3) 读取重定向 Location 的 fragment 拿 access_token。
        全程 best-effort：任何一步失败返回 None，调用方回退纯 BDUSS 老路径
        （对分享取链来说 BDUSS + tplconfig 仍然有效，此 token 主要满足
        百度对大文件 dlink 的 access_token 校验，并给未来收紧 BDUSS 留后路）。"""
        try:
            code, raw, location, _ = http.request_no_redirect(
                "GET", AUTHORIZE_URL, cookie,
                {"User-Agent": UA_BROWSER, "Referer": REFERER})
            token = _token_from_url(location)
            if token:
                return token
            m_bdstoken = re.search(r'name="bdstoken"\s+value="([^"]+)"', raw or "")
            m_client = re.search(r'name="client_id"\s+value="([^"]+)"', raw or "")
            if not (m_bdstoken and m_client):
                return None
            form = urllib.parse.urlencode({
                "grant_permissions_arr": "netdisk",
                "bdstoken": m_bdstoken.group(1),
                "client_id": m_client.group(1),
                "response_type": "token",
                "display": "page",
                "grant_permissions": "basic,netdisk",
            })
            _, raw2, location2, _ = http.request_no_redirect(
                "POST", AUTHORIZE_URL, cookie, form,
                {"User-Agent": UA_BROWSER, "Referer": AUTHORIZE_URL,
                 "Content-Type": "application/x-www-form-urlencoded"})
            return _token_from_url(location2) or _token_from_url(raw2)
        except Exception:
            return None

    # ---------------- 业务 API ----------------

    def _tplconfig(self, surl, uk, shareid, cookie):
        """服务端下发 sign + timestamp（5 分钟有效）。"""
        params = "fields=sign,timestamp&channel=chunlei&web=1&app_id=%s&clienttype=0" % APP_ID
        if surl:
            params += "&surl=%s" % surl
        if shareid:
            params += "&shareid=%s" % shareid
        if uk:
            params += "&uk=%s" % uk
        url = TPLCONFIG_URL + "?" + params
        _, raw, _ = http.get(url, cookie, headers={
            "User-Agent": UA_TPL, "Referer": REFERER})
        data = http.parse_json(raw)
        errno = (data or {}).get("errno")
        if not data or errno != 0 or "data" not in data:
            if errno == 9019:
                raise PanError(
                    "获取签名被百度风控拦截（errno=9019 need verify）。\n"
                    "原因通常为：当前网络出口 IP 被百度判定为风险（数据中心 IP / 代理 / 频繁请求"
                    "常触发滑块验证）。\n"
                    "建议：① 在本机家庭宽带下运行（不要走数据中心代理或服务器 IP）；"
                    "② 在 --cookie 中带上有效的 BDUSS 登录态；③ 稍后重试。")
            msg = (data or {}).get("show_msg") if data else raw
            raise PanError("获取签名失败（errno=%s）：%s" % (errno if data else "?", msg))
        return data["data"]["sign"], str(data["data"]["timestamp"])

    def _collect(self, surl, uk, shareid, pwd, sign, timestamp, cookie,
                 dir_path, prefix, recursive, out):
        page = 1
        seckey = shareid = uk = None
        while True:
            lst, seckey, sid, uk_ = self._wxlist_page(
                surl, uk, shareid, pwd, dir_path, page, cookie)
            if sid:
                shareid = sid
            if uk_:
                uk = uk_
            for it in lst:
                is_dir = it.get("isdir") == 1
                name = it.get("server_filename")
                size = int(it.get("size") or 0)
                fpath = it.get("path", "")
                out.append({
                    "path": (prefix + name) if name else name,
                    "name": name,
                    "size": size,
                    "is_dir": is_dir,
                    "url": None,
                    "headers": None,
                    "_fs_id": it.get("fs_id"),
                    "_path": fpath,
                })
                if is_dir and recursive and fpath:
                    self._collect(surl, uk, shareid, pwd, sign, timestamp, cookie,
                                  fpath, (prefix + name + "/") if name else prefix,
                                  recursive, out)
            if len(lst) < 1000:
                break
            page += 1
        return seckey, shareid, uk

    def _wxlist_page(self, surl, uk, shareid, pwd, dir_path, page, cookie):
        if uk and shareid:
            p = "&uk=%s&shareid=%s" % (uk, shareid)
        else:
            p = "&shorturl=%s" % surl
        body = ("%s&dir=%s&root=1&pwd=%s&page=%s&num=1000&order=time"
                % (p, urllib.parse.quote(dir_path, safe=""), pwd or "", page))
        code, raw, _ = http.request(
            "POST", WXLIST_URL, cookie, body,
            {"User-Agent": UA_NETDISK, "Referer": REFERER,
             "Content-Type": "application/x-www-form-urlencoded"})
        data = http.parse_json(raw)
        if not data or data.get("errno") != 0:
            msg = (data or {}).get("show_msg") if data else raw
            raise PanError("列分享文件失败（errno=%s）：%s"
                           % ((data or {}).get("errno") if data else "?", msg))
        d = data.get("data", {}) or {}
        return d.get("list") or [], d.get("seckey"), d.get("shareid"), d.get("uk")

    def _download_link(self, fs_id, sign, timestamp, randsk, shareid, uk, cookie):
        if not shareid or not uk:
            raise PanError("缺少 shareid/uk，无法构造下载请求（分享数据异常）")
        url = DOWNLOAD_URL % (sign, timestamp)
        extra = '{"sekey":"%s"}' % randsk
        body = ("encrypt=0&extra=%s&fid_list=[%s]&primaryid=%s&uk=%s"
                "&product=share&type=nolimit"
                % (urllib.parse.quote(extra, safe=""), int(fs_id), shareid, uk))
        code, raw, _ = http.request(
            "POST", url, cookie, body,
            {"User-Agent": UA_BROWSER, "Referer": REFERER,
             "Content-Type": "application/x-www-form-urlencoded"})
        data = http.parse_json(raw)
        errno = (data or {}).get("errno") if data else "?"
        if not data or errno != 0:
            msg = (data or {}).get("show_msg") if data else raw
            if errno == -20:
                raise PanError("取直链失败：未登录（errno=-20）。请确认 --cookie 内含有效的 BDUSS。")
            if errno == 113:
                raise PanError("取直链失败：签名错误（errno=113）。可能是 sign/timestamp "
                               "过期（有效期约 5 分钟），请重新运行；或 Cookie 失效。")
            if errno == -6:
                raise PanError("取直链失败：文件不存在或分享已失效（errno=-6）。")
            raise PanError("取直链失败（errno=%s）：%s" % (errno, msg))
        dl = (data or {}).get("list") or []
        if not dl:
            raise PanError("未返回 dlink（响应异常）")
        return dl[0].get("dlink")

    def resolve(self, url, pwd=None, cookie=None, token=None,
                recursive=True, dry_run=False, **opts):
        surl, link_pwd, uk_share = parse_baidu_link(url)
        if surl is None and not (uk_share and uk_share[0]):
            raise PanError("无法识别百度分享链接（需要 pan.baidu.com/s/xxx 或 ?surl=xxx 形式）")
        pwd = pwd or link_pwd
        uk, shareid = uk_share

        if dry_run:
            return "(dry-run)", [{
                "path": "（dry-run 不实际解析）", "name": "", "size": 0,
                "is_dir": False, "url": None, "headers": {},
            }]

        if not cookie or "BDUSS" not in cookie:
            raise PanError(
                "百度网盘取直链需登录态 Cookie（--cookie，需含 BDUSS）。\n"
                "获取方式：浏览器登录 pan.baidu.com → F12 → Network → 复制任意"
                " pan.baidu.com 请求的 Cookie 头。\n"
                "（分享有提取码用 --pwd 传入。）")

        # 1) 服务端签名
        sign, timestamp = self._tplconfig(surl, uk, shareid, cookie)

        # 1.5) best-effort 拿 OAuth AccessToken（失败不影响主流程）
        self._access_token = self._get_access_token(cookie)

        # 2) 递归列文件（同时拿到 seckey→randsk、shareid、uk）
        items = []
        seckey, shareid, uk = self._collect(
            surl, uk, shareid, pwd, sign, timestamp, cookie,
            "/", "", recursive, items)
        if not items:
            raise PanError("分享内没有文件（可能已清空、链接失效或需提取码）")
        randsk = _decode_seckey(seckey)

        # 3) 为每个文件取下载直链（单文件失败不中断整批；50/批 + 批间 1s 节流）
        files = [it for it in items if not it["is_dir"]]
        for i in range(0, len(files), 50):
            for it in files[i:i + 50]:
                dlink, err = isolate(
                    self._download_link,
                    it["_fs_id"], sign, timestamp, randsk, shareid, uk, cookie)
                if err:
                    it["error"] = err
                    continue
                # 有大文件直链校验时百度要求 dlink 带 access_token（LinkSwift 同款处理）
                if dlink and self._access_token and "access_token=" not in dlink:
                    sep = "&" if "?" in dlink else "?"
                    dlink = "%s%saccess_token=%s" % (dlink, sep, self._access_token)
                it["url"] = dlink
                it["headers"] = {"User-Agent": UA_BROWSER, "Referer": REFERER}
            batch_throttle(i, 50, len(files))
        return surl or (shareid and ("share:%s" % shareid)) or "百度分享", items

    def dry_run_info(self, url):
        surl, pwd, uk_share = parse_baidu_link(url)
        if surl is None and not (uk_share and uk_share[0]):
            return "  !! 无法识别百度分享链接（需 pan.baidu.com/s/xxx 或 ?surl=xxx）"
        return (
            "  1) GET  %s?&surl=%s&fields=sign,timestamp&app_id=%s&clienttype=0\n"
            "     （服务端下发 sign + timestamp，有效期约 5 分钟；UA: %s）\n"
            "  2) POST %s\n"
            "     body: &shorturl=%s&dir=/&root=1&pwd=%s&page=1&num=1000&order=time\n"
            "     （UA: %s；响应含 list 文件列表 + seckey→randsk + shareid + uk；递归换 dir）\n"
            "  3) POST %s\n"
            "     ?sign=<第1步sign>&timestamp=<第1步timestamp>\n"
            "     body: encrypt=0&extra=urlencode({\"sekey\":\"<randsk>\"})&fid_list=[fs_id]&primaryid=<shareid>&uk=<uk>&product=share&type=nolimit\n"
            "     返回 list[0].dlink 即下载直链（免费账号限速；有效期约 8h）\n"
            "  取直链需登录态 Cookie（含 BDUSS）\n"
            % (TPLCONFIG_URL, surl or "", APP_ID, UA_TPL,
               WXLIST_URL, surl or "", pwd or "",
               UA_NETDISK, DOWNLOAD_URL % ("<sign>", "<timestamp>"))
        )
