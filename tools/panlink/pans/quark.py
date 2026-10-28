#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
夸克网盘 provider —— 移植自 YunX (github.com/CYQawa/YunX) 核心逻辑。
策略：免转存取直链（登录态无 50MB 限制；游客态 ≤50MB）。

接口链路：
  sharepage/token  → 拿 stoken
  sharepage/detail → 列文件
  file/download    → 免转存换直链（带 pwd_id/stoken/share_fid_token）
"""

import os
import re
import sys
import urllib.parse

try:
    from . import http
    from .base import PanError, PanResolver, isolate, batch_throttle, human_size
except ImportError:  # 支持 python pans/quark.py 直接运行（非包上下文）
    # 注意：直跑时 sys.path[0] 是本目录，pans/http.py 会遮蔽 stdlib http
    # （urllib.request 内部 import http.client 会解析到我们），必须先移除再导入。
    _here = os.path.dirname(os.path.abspath(__file__))
    sys.path = [p for p in sys.path if os.path.abspath(p or ".") != _here]
    sys.path.insert(0, os.path.dirname(_here))
    from pans import http
    from pans.base import PanError, PanResolver, isolate, batch_throttle, human_size

API_BASE = "https://drive-pc.quark.cn"
TOKEN_URL = API_BASE + "/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc"
DETAIL_URL = API_BASE + "/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc"
DOWNLOAD_URL = API_BASE + "/1/clouddrive/file/download?pr=ucpro&fr=pc&sys=win32&ve=3.23.2"
CONFIG_URL = API_BASE + "/1/clouddrive/config?pr=ucpro&fr=pc"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.12-a038f7b798 "
      "Safari/537.36 Channel/pckk_other_ch")
REFERER = "https://pan.quark.cn/"
ORIGIN = "https://pan.quark.cn/"

_QUARK_RE = re.compile(r"pan\.quark\.cn/s/([A-Za-z0-9]+)", re.IGNORECASE)
_PWD_URL_RE = re.compile(r"[?&]pwd=([A-Za-z0-9]+)")
_PWD_TEXT_RE = re.compile(r"(?:提取码|访问码|密码)[：:]\s*([A-Za-z0-9]{4,8})")


def parse_quark_link(text):
    text = (text or "").strip()
    m = re.search(r"https?://[^\s]+", text)
    if not m:
        return None, None
    url = m.group(0).rstrip("。，,；;)]}'\"")
    sid_m = _QUARK_RE.search(url)
    if not sid_m:
        return None, None
    share_id = sid_m.group(1)
    pwd = _PWD_URL_RE.search(url)
    pwd = pwd.group(1) if pwd else None
    if not pwd:
        t = _PWD_TEXT_RE.search(text)
        pwd = t.group(1) if t else None
    return share_id, pwd


def _set_or_replace(cookie, name, value):
    parts = [p.strip() for p in cookie.split(";") if p.strip()]
    idx = next((i for i, p in enumerate(parts) if p.startswith(name + "=")), None)
    kv = "%s=%s" % (name, value)
    if idx is not None:
        parts[idx] = kv
    else:
        parts.append(kv)
    return "; ".join(parts)


def merge_cookies(original, set_cookies):
    cookie = original
    for sc in (set_cookies or []):
        kv = sc.split(";", 1)[0].strip()
        if "=" not in kv:
            continue
        name = kv.split("=", 1)[0]
        if name in ("__puus", "__pus"):
            cookie = _set_or_replace(cookie, name, kv.split("=", 1)[1])
    return cookie


def without_puus(cookie):
    return "; ".join(
        p for p in [p.strip() for p in (cookie or "").split(";") if p.strip()]
        if not p.startswith("__puus=")
    )


def refresh_cookie(cookie):
    no_puus = without_puus(cookie)
    _, _, set_cookies = http.get(CONFIG_URL, no_puus, headers={"Referer": REFERER})
    if set_cookies:
        merged = merge_cookies(cookie, set_cookies)
        if merged != cookie:
            return merged
    return cookie


class QuarkResolver(PanResolver):
    name = "夸克网盘"
    requires_auth = False  # 游客态可用；登录态需 cookie
    auth_hint = "登录态需 --cookie（含 __pus 与 __puus）；否则用 --guest 游客态"

    def match(self, url):
        return bool(_QUARK_RE.search(url or ""))

    def resolve(self, url, pwd=None, cookie=None, token=None,
                recursive=True, dry_run=False, guest=False, **opts):
        share_id, link_pwd = parse_quark_link(url)
        if not share_id:
            raise PanError("无法识别夸克分享链接（需要 pan.quark.cn/s/xxx 形式）")
        pwd = pwd or link_pwd

        if dry_run:
            return "(dry-run)", [{
                "path": "（dry-run 不实际解析）", "name": "", "size": 0,
                "is_dir": False, "url": None, "headers": {},
            }]

        if guest:
            cookie = None
        else:
            if not cookie or "__puus=" not in cookie:
                raise PanError("登录态需要带 __puus 的夸克 Cookie（用 --cookie 传入），或加 --guest 游客态")
            cookie = refresh_cookie(cookie)

        stoken, title, _ = self._get_share_token(share_id, pwd, cookie)
        results = []

        def walk(pdir_fid, prefix):
            files = self._list_files(share_id, stoken, pdir_fid, cookie)
            for f in files:
                if f["is_dir"] and recursive:
                    walk(f["fid"], prefix + (f["name"] or f["fid"]) + "/")
                else:
                    results.append({
                        "path": prefix + (f["name"] or f["fid"]),
                        "name": f["name"],
                        "size": f["size"],
                        "is_dir": f["is_dir"],
                        "url": None,
                        "headers": {"Referer": REFERER, "User-Agent": UA},
                        "_fid": f["fid"],
                        "_fid_token": f["fid_token"],
                    })

        walk("0", "")

        # 逐个取直链（单文件失败不中断整批；15/批 + 批间 1s 节流）。
        # 注意：_get_link 的 Set-Cookie(__pugs) 是逐文件下发的游客 cookie，
        # 必须回填到该文件自己的 headers，不能全局共用（LinkSwift 同款处理）。
        files = [it for it in results if not it["is_dir"]]
        for i in range(0, len(files), 15):
            for it in files[i:i + 15]:
                got, err = isolate(self._get_link, it["_fid"], it["_fid_token"],
                                   share_id, stoken, cookie)
                if err:
                    it["error"] = err
                    continue
                durl, name, size, guest_cookie = got
                if name and not it["name"]:
                    it["name"] = name
                if size:
                    it["size"] = size
                it["url"] = durl
                c = guest_cookie or cookie
                if c:
                    it["headers"]["Cookie"] = c
            batch_throttle(i, 15, len(files))
        return title, results

    # ---------------- 业务 API ----------------

    def _get_share_token(self, share_id, pwd, cookie):
        body = {
            "pwd_id": share_id,
            "passcode": pwd or "",
            "support_visit_limit_private_share": True,
        }
        _, raw, _ = http.post_json(TOKEN_URL, cookie, body)
        data = http.parse_json(raw)
        if not data or data.get("status") != 200:
            msg = (data or {}).get("message") if data else raw
            raise PanError("获取分享凭证失败: %s" % msg)
        d = data.get("data", {}) or {}
        return d.get("stoken"), d.get("title"), d.get("first_fid")

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
            _, raw, _ = http.get(url, cookie, headers={"Origin": ORIGIN, "Referer": REFERER})
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

    def _guest_error(self, code, msg):
        if code == 23018:
            return "该文件超出游客可获取的大小上限（夸克实测约 50MB），请登录夸克网盘再下载"
        if code == 31001:
            return "该分享需要登录夸克网盘后才能下载"
        return msg or "获取下载链接失败"

    def _get_link(self, fid, fid_token, share_id, stoken, cookie):
        body = {
            "fids": [fid], "fids_token": [fid_token], "pwd_id": share_id,
            "stoken": stoken, "speedup_session": "", "token": "",
        }
        if cookie:
            _, raw, set_cookies = http.post_json(DOWNLOAD_URL, cookie, body)
        else:
            headers = {"Origin": ORIGIN, "Referer": REFERER}
            _, raw, set_cookies = http.request("POST", DOWNLOAD_URL, None, body, headers)
        data = http.parse_json(raw)
        code = (data or {}).get("code")
        if not data or (data.get("status") != 200 and code != 0):
            msg = (data or {}).get("message") if data else raw
            raise PanError(self._guest_error(code, msg))
        arr = data.get("data") or []
        if not arr:
            raise PanError("未返回下载链接")
        it = arr[0]
        guest_cookie = None
        for sc in (set_cookies or []):
            kv = sc.split(";", 1)[0].strip()
            if kv.startswith("__pugs=") and len(kv) > len("__pugs="):
                guest_cookie = kv
        return it.get("download_url"), it.get("file_name") or it.get("filename"), it.get("size", 0) or 0, guest_cookie

    def dry_run_info(self, url):
        share_id, pwd = parse_quark_link(url)
        if not share_id:
            return "  !! 无法识别夸克链接"
        return ("  1) POST %s\n     {\"pwd_id\":\"%s\",\"passcode\":\"%s\"}\n"
                "  2) GET  %s (带 Origin/Referer)\n"
                "  3) POST %s (免转存取直链)\n"
                "  下载需 Referer: %s" % (TOKEN_URL, share_id, pwd or "",
                                         DETAIL_URL, DOWNLOAD_URL, REFERER))


# ----------------- 兼容原 quark.py 的独立 CLI -----------------

def main(argv=None):
    import argparse
    import json
    import sys
    p = argparse.ArgumentParser(description="夸克网盘分享直链解析器（YunX 移植版）")
    p.add_argument("share_url")
    p.add_argument("--cookie")
    p.add_argument("--pwd")
    p.add_argument("--guest", action="store_true")
    p.add_argument("--no-recursive", action="store_true")
    p.add_argument("--out")
    p.add_argument("--aria2")
    p.add_argument("--json", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args(argv)

    r = QuarkResolver()
    if args.dry_run:
        print(r.dry_run_info(args.share_url))
        return 0
    try:
        title, results = r.resolve(args.share_url, args.pwd, args.cookie,
                                   recursive=not args.no_recursive, guest=args.guest)
    except PanError as e:
        print("错误: %s" % e, file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps({"title": title, "files": results}, ensure_ascii=False, indent=2))
        return 0
    print("分享标题: %s" % (title or "(无标题)"))
    print("文件数: %d\n" % len(results))
    for it in results:
        tag = "[DIR]" if it["is_dir"] else "[FILE]"
        print("%s %-12s %s" % (tag, human_size(it["size"]), it["path"]))
        if not it["is_dir"]:
            print("      %s" % it["url"])
    if args.aria2:
        with open(args.aria2, "w", encoding="utf-8") as fp:
            for it in results:
                if it["is_dir"]:
                    continue
                fp.write(it["url"] + "\n")
                fp.write("  dir=%s\n" % (os.path.dirname(it["path"]) or "."))
                fp.write("  out=%s\n" % os.path.basename(it["path"]))
                for k, v in r.aria2_headers(it).items():
                    fp.write("  header=%s: %s\n" % (k, v))
                fp.write("\n")
        print("\n已导出 aria2 输入文件: %s" % args.aria2)
    if args.out:
        os.makedirs(args.out, exist_ok=True)
        ok = 0
        for it in results:
            if it["is_dir"]:
                continue
            try:
                r.download(it, args.out, args.cookie)
                ok += 1
                print("  ✓ %s" % it["path"])
            except PanError as e:
                print("  ✗ %s : %s" % (it["path"], e), file=sys.stderr)
        print("下载完成: %d/%d" % (ok, len(results)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
