#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
UC 网盘 provider —— 分享链接解析取直链
=====================================
移植思路来源：LinkSwift（hmjz100/LinkSwift，AGPL-3.0）的 $uc 适配器 + 本地 quark.py。
UC 与夸克同族（同一套 clouddrive v1 API：fid / stoken / share_fid_token 体系），
但 host、pr 参数、UA 不同，且取链端点已从 LinkSwift 源码确认：

    POST https://pc-api.uc.cn/1/clouddrive/file/download?pr=UCBrowser&fr=pc&sys=win32&ve=1.8.8
    body（分享）: {"fids":[...], "fids_token":[...], "pwd_id": "<分享ID>", "stoken": "<列表stoken>"}
    body（我的）: {"fids":[...]}

LinkSwift 的 stoken / share_fid_token 是从页面已加载数据（React Fiber）里刮的；
CLI 没有页面，所以必须自己调 share 接口拿（与夸克同构，端点按同族推断）：

    POST .../1/clouddrive/share/sharepage/token   → stoken（body: pwd_id + passcode）
    GET  .../1/clouddrive/share/sharepage/detail   → 列文件（含 share_fid_token）

⚠️ 成熟度：🔶 实验性。2026-10-23 实测：sharepage/token 与 detail 端点均存活
   （假分享 ID 返回业务错误而非 404，响应结构与夸克完全同族：
   status/code/message/req_id/timestamp），download 端点返回 14001 参数校验错误。
   但未经真实分享全链路验证；若取链失败优先查 _get_link 的错误码分支。

接口链路：
  1) POST share/sharepage/token   {"pwd_id": "<s/xxx 的 xxx>", "passcode": "<提取码>"}
  2) GET  share/sharepage/detail  （分页 _page/__size=100，递归进子目录）
  3) POST file/download           （批量 ≤15，批间 sleep 1s）

所需凭据：drive.uc.cn 登录态 Cookie（--cookie）。游客态与夸克同族可能可用
（错误码 23018 = 超出游客可获取大小上限），但不保证，以实测为准。
"""

import re
import time
import urllib.parse

from . import http
from .base import PanError, PanResolver

API_BASE = "https://pc-api.uc.cn"
TOKEN_URL = API_BASE + "/1/clouddrive/share/sharepage/token?pr=UCBrowser&fr=pc"
DETAIL_URL = API_BASE + "/1/clouddrive/share/sharepage/detail?pr=UCBrowser&fr=pc"
DOWNLOAD_URL = (API_BASE + "/1/clouddrive/file/download"
                "?pr=UCBrowser&fr=pc&sys=win32&ve=1.8.8")

# LinkSwift config.$uc.api.ua（源码 430-432 行硬编码）
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) uc-cloud-drive/1.8.8 Chrome/100.0.4896.160 "
      "Electron/18.3.5.16-b62cf9c50d Safari/537.36 Channel/ucpan_other_ch")
SEC_CH_UA = '"Not=A?Brand";v="99", "Chromium";v="100", "Google Chrome";v="100"'
REFERER = "https://drive.uc.cn/"
ORIGIN = "https://drive.uc.cn"

# 批量与节流（与 LinkSwift 一致：15/批 + 批间 sleep 1000ms）
BATCH = 15
BATCH_SLEEP = 1.0

# 分享链接：https://drive.uc.cn/s/XXXX 或 /share/XXXX（LinkSwift 8486 行正则同款）
_UC_RE = re.compile(r"drive\.uc\.cn/(?:s|share)/([A-Za-z0-9]+)", re.IGNORECASE)
_PWD_URL_RE = re.compile(r"[?&]pwd=([A-Za-z0-9]{4,8})")
_PWD_TEXT_RE = re.compile(r"(?:提取码|访问码|密码)[：:]\s*([A-Za-z0-9]{4,8})")


def parse_uc_link(text):
    """从任意文本中提取 (share_id, pwd)。"""
    text = (text or "").strip()
    m = re.search(r"https?://[^\s]+", text)
    if not m:
        return None, None
    url = m.group(0).rstrip("。，,；;)]}'\"")
    sid_m = _UC_RE.search(url)
    if not sid_m:
        return None, None
    share_id = sid_m.group(1)
    pwd = _PWD_URL_RE.search(url)
    pwd = pwd.group(1) if pwd else None
    if not pwd:
        t = _PWD_TEXT_RE.search(text)
        pwd = t.group(1) if t else None
    return share_id, pwd


class UcResolver(PanResolver):
    name = "UC网盘"
    requires_auth = False  # 游客态可能与夸克同族可用（23018 上限）；登录态需 --cookie
    auth_hint = ("登录态需 --cookie（drive.uc.cn 的 Cookie，全部复制）；"
                 "游客态直接跑，超出大小上限会提示（错误码 23018）")

    def match(self, url):
        return bool(_UC_RE.search(url or ""))

    # ---------------- 业务 API ----------------

    def _headers(self, cookie):
        h = {
            "User-Agent": UA,
            "Sec-Ch-Ua": SEC_CH_UA,
            "Origin": ORIGIN,
            "Referer": REFERER,
        }
        if cookie:
            h["Cookie"] = cookie
        return h

    def _get_share_token(self, share_id, pwd, cookie):
        body = {
            "pwd_id": share_id,
            "passcode": pwd or "",
            "support_visit_limit_private_share": True,
        }
        _, raw, _ = http.post_json(TOKEN_URL, cookie, body, self._headers(cookie))
        data = http.parse_json(raw)
        if not data or data.get("status") != 200:
            msg = (data or {}).get("message") if data else raw
            raise PanError("获取分享凭证失败: %s" % msg)
        d = data.get("data", {}) or {}
        stoken = d.get("stoken")
        if not stoken:
            raise PanError("分享凭证响应异常（无 stoken）。提取码是否正确？")
        return stoken, d.get("title")

    def _list_files(self, share_id, stoken, pdir_fid, cookie):
        out = []
        page = 1
        while True:
            params = {
                "pwd_id": share_id,
                "stoken": urllib.parse.quote(stoken, safe=""),
                "pdir_fid": pdir_fid,
                "ver": "2", "force": "0", "_page": page, "_size": 100,
                "_fetch_banner": "0", "_fetch_share": "0",
                "fetch_relate_conversation": "0", "_fetch_total": "1",
                "_sort": "file_type:asc,file_name:asc",
            }
            url = DETAIL_URL + "&" + urllib.parse.urlencode(params)
            _, raw, _ = http.get(url, cookie, self._headers(cookie))
            data = http.parse_json(raw)
            if not data or data.get("status") != 200:
                msg = (data or {}).get("message") if data else raw
                raise PanError("获取文件列表失败: %s" % msg)
            arr = ((data.get("data", {}) or {}).get("list", []) or [])
            for it in arr:
                out.append({
                    "fid": it.get("fid"),
                    "name": it.get("file_name"),
                    "size": it.get("size", 0) or 0,
                    "is_dir": bool(it.get("dir", False)),
                    "fid_token": it.get("share_fid_token"),
                })
            if len(arr) < 100 or page >= 100:
                break
            page += 1
        return out

    def _err_text(self, code, msg):
        # 与夸克同族的错误码（LinkSwift $uc 8500 行附近同款处理）
        if code == 31001:
            return "该分享需要登录 UC 网盘后才能下载（请用 --cookie 传入登录态）"
        if code == 23018:
            return ("该文件超出游客可获取的大小上限，请登录 UC 网盘后再下载"
                    "（--cookie 传入 drive.uc.cn 的 Cookie）")
        if code == 14001 or (msg and "分享链接不存在" in str(msg)):
            return ("UC 说分享链接不存在（code 14001）。请检查链接是否完整；"
                    "有提取码的用 --pwd 传入。")
        return msg or "获取下载链接失败"

    def _get_link(self, fid, fid_token, share_id, stoken, cookie):
        body = {
            "fids": [fid],
            "fids_token": [fid_token],
            "pwd_id": share_id,
            "stoken": stoken,
        }
        _, raw, _ = http.post_json(DOWNLOAD_URL, cookie, body, self._headers(cookie))
        data = http.parse_json(raw)
        code = (data or {}).get("code")
        if not data or (data.get("status") != 200 and code != 0):
            msg = (data or {}).get("message") if data else raw
            raise PanError(self._err_text(code, msg))
        arr = data.get("data") or []
        if not arr:
            raise PanError("未返回下载链接")
        it = arr[0]
        return (it.get("download_url"),
                it.get("file_name") or it.get("filename"),
                it.get("size", 0) or 0)

    # ---------------- 主流程 ----------------

    def resolve(self, url, pwd=None, cookie=None, token=None,
                recursive=True, dry_run=False, **opts):
        share_id, link_pwd = parse_uc_link(url)
        if not share_id:
            raise PanError("无法识别 UC 分享链接（需要 drive.uc.cn/s/xxx 形式）")
        pwd = pwd or link_pwd

        if dry_run:
            return "(dry-run)", [{
                "path": "（dry-run 不实际解析）", "name": "", "size": 0,
                "is_dir": False, "url": None, "headers": {},
            }]

        stoken, title = self._get_share_token(share_id, pwd, cookie)
        results = []
        pending = []  # 待取链文件（fid, fid_token, path 前缀, name, size, is_dir）

        def walk(pdir_fid, prefix):
            for f in self._list_files(share_id, stoken, pdir_fid, cookie):
                if f["is_dir"] and recursive:
                    walk(f["fid"], prefix + (f["name"] or f["fid"]) + "/")
                else:
                    pending.append((f, prefix))

        walk("0", "")

        # 取直链：批量 15 + 批间 sleep（LinkSwift 同款节流）
        for i in range(0, len(pending), BATCH):
            batch = pending[i:i + BATCH]
            for f, prefix in batch:
                durl, name, size = self._get_link(
                    f["fid"], f["fid_token"], share_id, stoken, cookie)
                headers = {"User-Agent": UA, "Sec-Ch-Ua": SEC_CH_UA,
                           "Referer": REFERER, "Origin": ORIGIN}
                if cookie:
                    headers["Cookie"] = cookie
                results.append({
                    "path": prefix + (f["name"] or name or f["fid"]),
                    "name": f["name"] or name,
                    "size": size,
                    "is_dir": False,
                    "url": durl,
                    "headers": headers,
                })
            if i + BATCH < len(pending):
                time.sleep(BATCH_SLEEP)
        return title, results

    def dry_run_info(self, url):
        share_id, pwd = parse_uc_link(url)
        if not share_id:
            return "  !! 无法识别 UC 链接（需 drive.uc.cn/s/xxx）"
        return (
            "  1) POST %s\n     {\"pwd_id\":\"%s\",\"passcode\":\"%s\"}  → stoken\n"
            "  2) GET  %s&pwd_id=%s&stoken=<quote>&pdir_fid=0&_page=1&_size=100（递归子目录）\n"
            "  3) POST %s\n     {\"fids\":[\"<fid>\"],\"fids_token\":[\"<share_fid_token>\"],"
            "\"pwd_id\":\"%s\",\"stoken\":\"<stoken>\"}（批量≤15，批间 sleep 1s）\n"
            "  请求头: User-Agent: <uc-cloud-drive/1.8.8 Electron UA>, Sec-Ch-Ua, Origin/Referer: %s\n"
            "  下载需带: UA + Sec-Ch-Ua + Referer + Cookie（登录态）\n"
            "  端点状态: sharepage/token 与 detail 已实测存活（2026-10-23，同族结构），"
            "但全链路未经真实分享验证"
            % (TOKEN_URL, share_id, pwd or "",
               DETAIL_URL, share_id, DOWNLOAD_URL, share_id, ORIGIN)
        )
