#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
迅雷云盘 provider —— 分享链接解析取直链
=====================================
参考 alist/OpenList 迅雷驱动（AGPL-3.0）的接口逆向实现。
策略：免转存分享取链（登录态，不需先把文件转存到自己的网盘）。

⚠️ 重要：迅雷当前对分享接口加了【图形验证码】风控（error_code 9 captcha_invalid）。
   完整流程：captcha/init（拿图片）→ 识别文字 → captcha/verify（拿 captcha_token）
            → 后续 share/list、file/download_url 都在请求头带 Captcha-Token。
   本实现会自动处理：触发验证码时下载图片到本地并提示你输入图中文字
   （也可用 --captcha-code 直接传入，跳过交互）。

接口链路（抓包自 pan.xunlei.com 网页端，2026-10 实测）：
  GET  api-pan.xunlei.com/drive/v1/share/list        → 列分享文件（支持递归子目录）
  POST api-pan.xunlei.com/drive/v1/file/download_url → 取下载直链（f*.xunlei.com）
  POST xluser-ssl.xunlei.com/v1/captcha/init         → 拿验证码图片+token
  POST xluser-ssl.xunlei.com/v1/captcha/verify       → 换 captcha_token
  POST xluser-ssl.xunlei.com/v1/shield/captcha/init  → 免验证码直取 captcha_token（风控通过时）

⚠️ 关于 shield 免验证码通道（2026-10-23 研究成果）：
  迅雷现行网页版的 captcha_sign 已从 LinkSwift 时代的「12 层硬编码盐 MD5」演进为
  「8 层盐 MD5 链 + 恒等终点」，全部从 pan.xunlei.com 现行生产 JS 提取并交叉验证：
    - 配置（utils-initial 模块 27）：clientId=Xqp0kJBXWhwaTpB6、
      packageName=pan.xunlei.com、signKey=k&&9(rT5LU、algVersion=1
    - 签名链（模块 14→40→14→17→26→53→14→49→14，共 8 层盐，终点函数条件恒假直接返回）：
      base = clientId + version + host + deviceId + timestamp(毫秒字符串)
      逐层 md5(上一层结果 + 盐)，最终 "1." + 结果
    - 模块 0 = blueimp-md5（app.js 匿名模块数组首位）
  **唯一未确认项**：version 常量（模块 185）的值——它不在已能拉取的 chunk 里
  （chunk 22/91/93 的 hash URL 均已 404），且服务端会强校验签名，
  用 1.92.62/2.0.0/3.6.5 等候选全部被拒（invalid captcha_sign）。
  补齐方法：浏览器登录 pan.xunlei.com → F12 → Sources 找到含
  `Xqp0kJBXWhwaTpB6` 的 chunk → 搜 `185:function` 取 version 导出值，
  填入下方 CLIENT_VERSION 并把 SHIELD_ENABLED 改 True 即全自动过盾。
  在补齐之前，shield 通道默认关闭，走原有「图片人工识别」流程（功能不受影响）。

所需凭据：迅雷登录态 Cookie（含 x_token / session 之一），从浏览器
F12 → Network → 复制任意 pan.xunlei.com 请求的 Cookie 头即可。
分享若设了提取码，用 --pwd 传入。
"""

import hashlib
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.parse
import uuid

from . import http
from .base import PanError, PanResolver, isolate, batch_throttle

USER_API = "https://xluser-ssl.xunlei.com"
PAN_API = "https://api-pan.xunlei.com"

CLIENT_ID = "XunleiWeb"
WEB_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

# ---- shield 免验证码通道配置（2026-10-23 从 pan.xunlei.com 现行生产 JS 提取）----
# 签名链：base = clientId + version + host + deviceId + timestamp，逐层 md5(上层+盐)
# 链途经模块 14→40→14→17→26→53→14→49→14（终点 P 条件恒假，直接返回输入）
SHIELD_CLIENT_ID = "Xqp0kJBXWhwaTpB6"      # 模块 27 配置（注意与 CLIENT_ID 不同）
SHIELD_PACKAGE = "pan.xunlei.com"
SHIELD_ALG_VERSION = "1"
SHIELD_SALTS = [
    "Q0HaIAoI3sasyPWsryjOulcq",                                    # m14.j
    "1Px33Ag0Kr4JijR741ur6Zo/HqOfOTBKH7XGckqGx1uFF3ngme7DAHJx8yd15En",  # m40.c
    "8en0IoATgahB9Br7ItSmSt",                                      # m14.x
    "oEIg9ldpW/AzcNIg7IpKSWIlltZSsabolxJMsSJgvSdN8v7DR8ukwsYlGLw0YT",  # m17.Q
    "cUHVguVfmsJqLcbiN+Pcml0FCt8PySoen",                           # m26.w
    "Q7qCtf9p",                                                    # m53.v
    "dcW1N1",                                                      # m14._
    "En7YUHQPnEiUoLssIFK+MuhQ0QCTt2bk5zP",                         # m49.d
]
# 模块 185 的 version 常量——唯一未确认项（所在 chunk 拉取失败），
# 候选 1.92.62/2.0.0/3.6.5/2.4.0/2.6.12/2.0.12 均被服务端拒绝。
# 补齐方式见模块 docstring；未确认前保持 False，走人工验证码流程。
SHIELD_VERSION = "1.92.62"
SHIELD_ENABLED = False

# 分享链接形如 https://pan.xunlei.com/s/XXXXXXXX
_XUNLEI_RE = re.compile(r"pan\.xunlei\.com/s/([A-Za-z0-9_-]+)", re.IGNORECASE)


def _uuid():
    return uuid.uuid4().hex


def _headers(cookie):
    return {
        "User-Agent": WEB_UA,
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://pan.xunlei.com",
        "Referer": "https://pan.xunlei.com/",
        "x-client-id": CLIENT_ID,
        "x-device-id": _uuid(),
        "x-trace-id": _uuid(),
        "Cookie": cookie or "",
    }


class XunleiResolver(PanResolver):
    name = "迅雷云盘"
    requires_auth = True
    auth_hint = ("需 --cookie（迅雷登录态：x_token 或 session）；分享可能还需 --pwd 提取码；"
                 "触发验证码时用 --captcha-code 传入图中文字")

    def __init__(self):
        self._captcha_token = None
        self._captcha_code = None
        #: 验证码图片保存位置（--captcha-png，GUI 调用用）；None = 只存临时文件
        self._captcha_png = None

    def match(self, url):
        return bool(_XUNLEI_RE.search(url or ""))

    def _share_id(self, url):
        m = _XUNLEI_RE.search(url or "")
        return m.group(1) if m else None

    def _post(self, url, body, headers):
        _, raw, _ = http.post_json(url, None, body, headers)
        return http.parse_json(raw)

    def resolve(self, url, pwd=None, cookie=None, token=None,
                recursive=True, dry_run=False, captcha_code=None,
                captcha_png=None, **opts):
        share_id = self._share_id(url)
        if not share_id:
            raise PanError("无法从链接提取 share_id：%s" % url)
        if not cookie:
            raise PanError(
                "迅雷云盘需登录态 Cookie（--cookie）。\n"
                "获取方式：浏览器登录 pan.xunlei.com → F12 → Network → 复制任意请求"
                "的 Cookie 头（需含 x_token 或 session）。\n"
                "分享若有提取码，用 --pwd 传入；若提示验证码，用 --captcha-code 传入图中文字。")
        self._captcha_code = captcha_code
        self._captcha_png = captcha_png
        headers = _headers(cookie)

        # 1) 列文件（递归，内部自动处理验证码）
        items = []
        title = self._collect(share_id, pwd, headers, "0", "", recursive, items)

        # 2) 为每个文件取下载直链（单文件失败不中断整批；15/批 + 批间 1s 节流）
        files = [it for it in items if not it["is_dir"]]
        for i in range(0, len(files), 15):
            for it in files[i:i + 15]:
                dl, err = isolate(
                    self._download_url, it["file_id"], it.get("space"), headers)
                if err:
                    it["error"] = err
                    continue
                it["url"] = dl.get("url")
                it["headers"] = {
                    "User-Agent": WEB_UA,
                    "Referer": "https://pan.xunlei.com/",
                }
            batch_throttle(i, 15, len(files))
        return title or share_id, items

    def _collect(self, share_id, pwd, headers, parent_id, prefix,
                 recursive, out):
        """递归列举分享内文件。迅雷分享的顶层与子目录都用 share/list，
        区别仅在 parentFolderId（顶层为 '0'，子目录为目录 id）。"""
        page = 1
        title = None
        while True:
            resources, t = self._list_once(
                share_id, pwd, headers, parent_id, page)
            if t and title is None:
                title = t
            for res in resources:
                is_dir = bool(res.get("folder"))
                fid = res.get("id") or res.get("fileId")
                name = res.get("name") or res.get("fileName") or fid
                item = {
                    "path": (prefix + name) if name else name,
                    "name": name,
                    "size": int(res.get("size") or 0),
                    "is_dir": is_dir,
                    "url": None,
                    "headers": None,
                    "file_id": fid,
                    "space": res.get("space"),
                }
                out.append(item)
                if is_dir and recursive and fid:
                    sub_title = self._collect(
                        share_id, pwd, headers, fid,
                        prefix + (name or fid) + "/", recursive, out)
                    if sub_title and title is None:
                        title = sub_title
            if len(resources) < 100:
                break
            page += 1
        return title

    def _list_once(self, share_id, pwd, headers, parent_id, page, _depth=0):
        params = {
            "shareId": share_id,
            "shareCode": pwd or "",
            "parentFolderId": parent_id,
            "pageSize": 100,
            "pageNum": page,
        }
        u = PAN_API + "/drive/v1/share/list?" + urllib.parse.urlencode(params)
        code, raw, _ = http.get(u, None, headers)
        data = http.parse_json(raw)
        # 触发验证码：自动获取后重试一次（避免无限循环）
        if code == 400 and (data or {}).get("error") == "captcha_invalid":
            if _depth >= 1:
                raise PanError("验证码未通过（captcha_invalid）。请用 --captcha-code "
                               "传入正确的图中文字后重试。")
            self._handle_captcha(headers)
            return self._list_once(share_id, pwd, headers, parent_id, page, _depth + 1)
        if code != 200 or not data or "data" not in data:
            msg = (data or {}).get("error_description") or (data or {}).get("message") \
                or (data or {}).get("msg") or "未知错误"
            raise PanError("列分享文件失败（HTTP %s）：%s" % (code, msg))
        d = data.get("data", {}) or {}
        resources = d.get("resources") or d.get("list") or []
        title = d.get("shareName") or d.get("title")
        return resources, title

    def _download_url(self, file_id, space, headers, _depth=0):
        body = {
            "fileId": file_id,
            "space": space or "",
            "params": {"expectDownloadLink": 1},
        }
        code, raw, _ = http.post_json(
            PAN_API + "/drive/v1/file/download_url", None, body, headers)
        data = http.parse_json(raw)
        if code == 400 and (data or {}).get("error") == "captcha_invalid":
            if _depth >= 1:
                raise PanError("下载直链需要验证码，但 captcha_token 失效。"
                               "请重新运行并传入 --captcha-code。")
            self._handle_captcha(headers)
            return self._download_url(file_id, space, headers, _depth + 1)
        if code != 200 or not data or data.get("code") not in (0, None):
            msg = (data or {}).get("error_description") or (data or {}).get("message") \
                or (data or {}).get("msg") or "未知"
            raise PanError("获取下载直链失败（HTTP %s）：%s" % (code, msg))
        return (data or {}).get("data", {}) or {}

    # ---------------- 验证码处理 ----------------

    def _captcha_sign(self, device_id, timestamp):
        """shield captcha_sign：8 层盐 MD5 链（2026-10-23 生产代码提取验证）。
        返回 "1." + md5chain(base)。仅 SHIELD_ENABLED=True 时使用。"""
        h = "%s%s%s%s%s" % (SHIELD_CLIENT_ID, SHIELD_VERSION,
                            "pan.xunlei.com", device_id, timestamp)
        for salt in SHIELD_SALTS:
            h = hashlib.md5((h + salt).encode("utf-8")).hexdigest()
        return "%s.%s" % (SHIELD_ALG_VERSION, h)

    def _shield_token(self, headers):
        """尝试 shield 免验证码通道：风控通过时直接拿 captcha_token（无需人工）。
        任何失败都返回 None，由调用方回退到人工识别流程。"""
        if not SHIELD_ENABLED:
            return None
        try:
            device_id = headers.get("x-device-id") or uuid.uuid4().hex
            ts = str(int(time.time() * 1000))
            body = {
                "client_id": SHIELD_CLIENT_ID,
                "action": "get:/drive/v1/about",
                "device_id": device_id,
                "meta": {
                    "username": "", "phone_number": "", "email": "",
                    "package_name": SHIELD_PACKAGE,
                    "client_version": SHIELD_VERSION,
                    "captcha_sign": self._captcha_sign(device_id, ts),
                    "timestamp": ts,
                    "user_id": "",
                },
            }
            _, raw, _ = http.post_json(
                USER_API + "/v1/shield/captcha/init", None, body,
                {"User-Agent": WEB_UA, "Content-Type": "application/json"})
            data = http.parse_json(raw)
            token = (data or {}).get("captcha_token")
            return token or None
        except Exception:
            return None

    def _handle_captcha(self, headers):
        """获取并缓存 captcha_token。已有则直接复用；否则先试 shield 免验证码
        （SHIELD_ENABLED 开启时），失败再走 init→（输入）→verify 人工流程。"""
        if self._captcha_token:
            headers["Captcha-Token"] = self._captcha_token
            return
        shield = self._shield_token(headers)
        if shield:
            self._captcha_token = shield
            headers["Captcha-Token"] = shield
            return
        init = self._post(USER_API + "/v1/captcha/init",
                          {"client_id": CLIENT_ID, "device_id": headers["x-device-id"]},
                          headers)
        if not init or "token" not in init:
            raise PanError("获取验证码失败（captcha/init 未返回 token）")
        init_token = init["token"]
        img_url = init.get("url")
        png_path = None
        if img_url:
            try:
                resp = http.stream_get(img_url, headers={"User-Agent": WEB_UA})
                data = resp.read()
                resp.close()
                fd, png_path = tempfile.mkstemp(suffix=".png", prefix="xunlei_captcha_")
                with os.fdopen(fd, "wb") as fp:
                    fp.write(data)
            except Exception:
                png_path = None
        code = self._captcha_code
        if not code:
            # 非交互（GUI / 管道 / CI）：stdin 上没有 TTY，input() 要么立刻
            # EOFError、要么一直阻塞到超时。两种都不如主动报错。
            # 约定：把验证码图片复制到调用方指定的 --captcha-png，并向 stderr
            # 打一行机器可读标记 CAPTCHA_REQUIRED<TAB>路径，调用方据此
            # 「展示图片 → 收文字 → 带 --captcha-code 重试」。
            interactive = False
            try:
                interactive = sys.stdin.isatty()
            except Exception:
                interactive = False
            if not interactive:
                if png_path is None:
                    raise PanError("需要图形验证码，但验证码图片下载失败")
                target = self._captcha_png or png_path
                if self._captcha_png:
                    try:
                        shutil.copyfile(png_path, target)
                    except Exception:
                        # 复制失败（目录不存在/不可写）就退回临时文件：
                        # 标记必须指向一个真实存在的位置，否则调用方拿到
                        # 一个打不开的路径，比没有标记更糟。
                        target = png_path
                sys.stderr.write("CAPTCHA_REQUIRED\t%s\n" % target)
                sys.stderr.flush()
                raise PanError(
                    "需要输入图形验证码（图片已保存：%s）。\n"
                    "把图中文字用 --captcha-code 传入后重试；"
                    "或加 --captcha-png 指定保存位置由界面展示。" % target)
            if png_path:
                print("验证码图片已保存：%s" % png_path, file=sys.stderr)
                print("请打开图片，输入其中的文字后回车：", file=sys.stderr)
                try:
                    code = input().strip()
                except EOFError:
                    raise PanError("无法交互读取验证码。请打开 %s 看文字，"
                                   "然后用 --captcha-code 传入后重跑。" % png_path)
            else:
                raise PanError("验证码需要人工输入，但图片下载失败。"
                               "请用 --captcha-code 传入图中文字。")
        verify = self._post(USER_API + "/v1/captcha/verify",
                            {"token": init_token, "code": code}, headers)
        if not verify or ("captcha_token" not in verify and "token" not in verify):
            raise PanError("验证码校验失败（captcha/verify 未返回 token）。"
                           "请确认图中文字是否正确。")
        self._captcha_token = verify.get("captcha_token") or verify.get("token")
        headers["Captcha-Token"] = self._captcha_token

    def dry_run_info(self, url):
        share_id = self._share_id(url)
        if not share_id:
            return "  !! 无法识别迅雷分享链接（需 pan.xunlei.com/s/xxx 形式）"
        return (
            "  1) [可选] POST %s/v1/captcha/init  → 拿验证码图片+token\n"
            "     POST %s/v1/captcha/verify {\"token\":\"...\",\"code\":\"图中文字\"} → captcha_token\n"
            "  2) GET  %s/drive/v1/share/list?shareId=%s&shareCode=<提取码>&parentFolderId=0&pageSize=100&pageNum=1\n"
            "     （请求头带 Captcha-Token: <token>；GET 而非 POST）\n"
            "  3) POST %s/drive/v1/file/download_url\n"
            "     {\"fileId\":\"<id>\", \"space\":\"<space>\", \"params\":{\"expectDownloadLink\":1}}\n"
            "  请求头需: x-client-id: %s, x-device-id: <uuid>, Referer: https://pan.xunlei.com/, Cookie: <登录态>\n"
            "  下载直链需带: Referer: https://pan.xunlei.com/"
            % (USER_API, USER_API, PAN_API, share_id, PAN_API, CLIENT_ID)
        )
