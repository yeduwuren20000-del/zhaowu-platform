#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pan.py —— 多网盘分享直链解析统一入口（零依赖）
==============================================
基于 YunX(夸克) 那套「解析分享 → 列文件 → 取直链」模式，扩展支持各大网盘。
自动识别链接类型并调度对应 provider。

支持的网盘（成熟度见下方，可用 = 已验证逻辑链路）：
  夸克网盘       ✅ 可用   （登录态无 50MB 限制；--guest 游客态 ≤50MB）
  蓝奏云         ✅ 可用   （无需登录，游客可取小文件直链）
  阿里云盘       ✅ 需 token（--token，你的 Bearer，免转存取链）
  天翼云盘       🔶 实验性 （需 --cookie 登录态）
  迅雷云盘       🔶 可用 （需 --cookie 登录态，免转存取链）
  百度网盘       ✅ 可用 （需 --cookie 含 BDUSS + sign 签名，免转存取链）
  115 网盘       ✅ 可用 （分享页公开接口，无需登录；带 --cookie 更稳，免转存取链）
  中国移动云盘   ✅ 可用 （列目录免登录；取直链需 --cookie 含 authorization + 自动签名）
  UC网盘         🔶 实验性 （与夸克同族 API；--cookie 登录态，游客态或可用）
  123云盘        🔶 实验性 （匿名解析；带 --cookie/--token 可解锁需登录分享）

用法
----
  # 列出支持的网盘
  python pan.py --list-pans

  # 自动识别网盘并解析（夸克登录态）
  python pan.py "https://pan.quark.cn/s/XXXX" --cookie "__pus=...; __puus=..."

  # 蓝奏云（无需登录）
  python pan.py "https://ww.lanzoux.com/iXXXX"

  # 阿里云盘（需 token）
  python pan.py "https://www.aliyundrive.com/s/XXXX" --token "你的Bearer"

  # 天翼云盘（需 cookie）
  python pan.py "https://cloud.189.cn/web/share?code=XXXX" --cookie "SESSION=..."

  # 迅雷云盘（需 cookie，分享若有提取码加 --pwd）
  python pan.py "https://pan.xunlei.com/s/XXXX" --cookie "x_token=...; session=..."

  # 百度网盘（需 BDUSS 登录态；有提取码加 --pwd）
  python pan.py "https://pan.baidu.com/s/1XXXX" --cookie "BDUSS=...; "
  python pan.py "https://pan.baidu.com/s/1XXXX" --cookie "BDUSS=...; " --pwd "abcd"

  # 115 网盘（分享页公开接口，无需登录；带 cookie 更稳）
  python pan.py "https://115.com/s/XXXX"
  python pan.py "https://115.com/s/XXXX?password=8888"
  python pan.py "https://115.com/s/XXXX" --pwd 8888 --cookie "SEID=...; UID=...; CID=..."

  # 中国移动云盘（和彩云）：列目录免登录；取直链需 --cookie 含 authorization
  python pan.py "https://caiyun.139.com/w/i/XXXX"
  python pan.py "https://yun.139.com/w/#/share/XXXX" --pwd abcd
  python pan.py "https://caiyun.139.com/w/i/XXXX" --cookie "authorization=...; auth_token=...; skey=..."

  # UC 网盘（与夸克同族；登录态 cookie，游客态或可用）
  python pan.py "https://drive.uc.cn/s/XXXX" --cookie "你的 UC Cookie"

  # 123 云盘（匿名解析；个别分享需登录时传 --cookie 或 --token）
  python pan.py "https://www.123pan.com/s/XXXX"
  python pan.py "https://www.123pan.com/s/XXXX" --pwd abcd

  # 通用：导出 aria2 / 推送 aria2 / 直接下载 / JSON / dry-run
  python pan.py "链接" --cookie "..." --aria2 links.txt
  python pan.py "链接" --cookie "..." --aria2-rpc http://127.0.0.1:6800/jsonrpc
  python pan.py "链接" --cookie "..." --out ./downloads
  python pan.py "链接" --cookie "..." --out ./downloads --jobs 5   # 5 线程并发下载
  python pan.py "链接" --cookie "..." --out ./downloads --threads 4  # 单文件 4 线程分块
  python pan.py "链接" --cookie "..." --json
  python pan.py "链接" --cookie "..." --dry-run

  # 解析缓存（直链 TTL 缓存，默认开启；重复解析同一分享不再请求网盘）
  python pan.py "链接" --no-cache        # 本次跳过缓存，强制重新解析
  python pan.py --cache-stats            # 查看缓存统计
  python pan.py --clear-cache            # 清空缓存

  # 批量清单（一行一条，# 开头为整行注释；链接后跟提取码，空格/|/制表符分隔）
  python pan.py --from-file list.txt --out ./downloads --jobs 4
  cat list.txt | python pan.py --from-file - --dry-run   # 从标准输入读

  # 断点续传（默认开启）：中断后重跑从 .part 接着下；已存在且大小相符自动跳过
  python pan.py "链接" --out ./downloads                 # 跳过已完成
  python pan.py "链接" --out ./downloads --overwrite     # 强制重下
  python pan.py "链接" --out ./downloads --no-resume     # 关闭续传
  python pan.py "链接" --out ./downloads --retry 3       # 网络重试次数（默认 2）

  # 凭据免粘贴（本机凭据保险库；Windows 下用 DPAPI 加密，与当前用户绑定）
  python pan.py "链接" --cookie "..." --save-cred   # 成功解析后把凭据存起来
  python pan.py "链接"                              # 之后直接跑，自动取出凭据
  python pan.py "链接" --cookie -                   # 从管道/标准输入读 cookie
  python pan.py "链接" --cookie-file cookie.txt     # 从文件读 cookie
  python pan.py --list-creds                        # 看存了哪些网盘凭据（不含明文）
  python pan.py "链接" --forget-cred                # 删掉该网盘的已存凭据
  python pan.py --clear-creds                       # 清空整个保险库
  python pan.py "链接" --no-cred                    # 本次不查保险库

aria2 推送需 aria2 以 --enable-rpc 启动；设了 --rpc-secret 时加 --aria2-secret。
分块下载需服务端支持 HTTP Range（自动探测，不支持自动回退单线程）。

缓存说明：key = 网盘 + 链接 + 提取码 + cookie 摘要（换登录态自动失效）；
TTL 按各网盘直链有效期设定（百度 4h / 115 10min / 移动 15min / 阿里 5min，其余 30min）；
只缓存至少拿到一个直链的结果。缓存文件在 ~/.cache/yunx-pans/links.json
（可用环境变量 YUNX_CACHE_DIR 覆盖），含登录态 headers，按本机敏感数据对待。

凭据保险库说明：存在 ~/.config/yunx-pans/credentials.json（YUNX_CRED_DIR 可覆盖）。
Windows 下用 DPAPI 加密（密文与当前 Windows 用户绑定，换账号/换机器解不开），
其他平台为明文 + 0600 权限（`--list-creds` 会如实显示加密方式）。

退出码：0=全部成功；1=用法/前提错误（缺参数、清单或凭据文件读不到、aria2 连不上）；
2=跑完了但有部分失败；3=全部失败（一条都没解析出来）。
下载完整性以响应头 Content-Length 为准（网盘给的 size 元数据不可靠）。
"""

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pans import batch
from pans import cache as link_cache
from pans import creds as cred_vault
from pans.aria2rpc import Aria2RPC, Aria2Error
from pans.base import PanError, human_size
from pans.quark import QuarkResolver
from pans.lanzou import LanzouResolver
from pans.aliyun import AliyunResolver
from pans.tianyi import TianyiResolver
from pans.baidu import BaiduResolver
from pans.pan115 import Pan115Resolver
from pans.xunlei import XunleiResolver
from pans.mobile import MobileResolver
from pans.uc import UcResolver
from pans.pan123 import Pan123Resolver

RESOLVERS = [
    QuarkResolver(), LanzouResolver(), AliyunResolver(), TianyiResolver(),
    BaiduResolver(), Pan115Resolver(), XunleiResolver(), MobileResolver(),
    UcResolver(), Pan123Resolver(),
]


def pick_resolver(url, forced=None):
    if forced:
        for r in RESOLVERS:
            if r.name == forced or r.name.startswith(forced):
                return r
        return None
    for r in RESOLVERS:
        if r.match(url):
            return r
    return None


def list_pans(as_json=False):
    """列出支持的网盘。

    ``as_json`` 是给 GUI / 工作台集成用的：人要看的表格直接读终端，程序
    要的是结构化字段（名称 / 是否需登录 / 凭据提示）。两种输出**同一份
    数据源**，不会出现「界面显示 8 家、实际支持 10 家」这种漂移。
    """
    if as_json:
        print(json.dumps({
            "pans": [{
                "name": r.name,
                "requiresAuth": bool(r.requires_auth),
                "authHint": r.auth_hint or "",
            } for r in RESOLVERS],
        }, ensure_ascii=False, indent=2))
        return
    print("支持的网盘（自动识别）：")
    for r in RESOLVERS:
        flag = "（%s）" % ("需登录" if r.requires_auth else "游客可用")
        print("  - %s  %s" % (r.name, flag))
        if r.auth_hint:
            print("      %s" % r.auth_hint)


def _fmt_secs(n):
    """秒数转中文可读（缓存提示用）。"""
    n = int(n or 0)
    if n >= 3600:
        return "%d 小时" % round(n / 3600)
    if n >= 60:
        return "%d 分钟" % round(n / 60)
    return "%d 秒" % n


def _read_secret_file(path, what):
    """从文件读凭据（去掉首尾空白与换行）。读不到直接报错退出，不静默。"""
    try:
        with open(path, "r", encoding="utf-8") as fp:
            text = fp.read().strip()
    except OSError as e:
        print("错误: 读取 %s 文件失败（%s）：%s" % (what, path, e), file=sys.stderr)
        return None
    if not text:
        print("错误: %s 文件是空的：%s" % (what, path), file=sys.stderr)
        return None
    return text


def _auth_help(r):
    """某网盘缺凭据时给出的具体操作指引（不含任何凭据值）。"""
    kind = "token（--token）" if "token" in (r.auth_hint or "") and \
        "cookie" not in (r.auth_hint or "") else "登录 Cookie（--cookie）"
    return (
        "[提示] %s 需要%s，但当前没有提供。三种给法：\n"
        "       ① --cookie \"...\"          直接粘贴\n"
        "       ② --cookie -               从管道/标准输入读（避免进 shell 历史）\n"
        "       ③ --cookie-file cookie.txt 从文件读\n"
        "       加 --save-cred 可在成功解析后存进本机保险库，之后直接跑即可。"
        % (r.name, kind))


#: 错误信息里出现这些词，才怀疑「登录态问题」。用于决定要不要提示「去更新凭据」——
#: 不区分的话，「分享不存在（errno=140）」这类错误也会被归因到凭据上，属误导。
_AUTH_HINTS = ("未登录", "登录", "登陆", "失效", "过期", "风控", "验证码",
               "凭据", "cookie", "Cookie", "token", "401", "403",
               "errno=-6", "9019")


def _looks_auth_related(message):
    msg = message or ""
    return any(k in msg for k in _AUTH_HINTS)


def list_creds():
    """打印保险库里已保存的凭据摘要（不含任何明文）。"""
    rows = cred_vault.entries()
    if not rows:
        print("凭据保险库为空。")
        print("用法: python pan.py \"链接\" --cookie \"...\" --save-cred")
        return
    be = cred_vault.backend()
    print("已保存凭据（%d 个网盘，加密方式: %s）："
          % (len(rows), "DPAPI（与当前 Windows 用户绑定）" if be == "dpapi"
             else "明文 + 0600 权限"))
    for row in rows:
        kinds = []
        if row["has_cookie"]:
            kinds.append("cookie" + (row["preview"].get("cookie") or ""))
        if row["has_token"]:
            kinds.append("token" + (row["preview"].get("token") or ""))
        print("  - %-12s %s（%s）"
              % (row["name"], "；".join(kinds) or "(空)",
                 cred_vault.fmt_age(row["updated_at"])))
    print("\n文件: %s" % cred_vault._path())


#: 退出码语义（脚本/自动化按此判断，比 parse 输出文本可靠）
RET_OK = 0        # 全部成功
RET_USAGE = 1     # 用法/识别/凭据错误，压根没跑起来
RET_PARTIAL = 2   # 跑完了，但有取链或下载失败
RET_FAIL = 3      # 所有条目都失败


class _ArgParser(argparse.ArgumentParser):
    """用法错误统一退出 1。

    argparse 默认用 2，会跟本工具「部分失败 = 2」的约定撞车——
    脚本无法区分「参数给错了」和「跑完但有文件失败」，所以这里改掉。
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        self.exit(RET_USAGE, "%s: error: %s\n" % (self.prog, message))


def _norm_path(p):
    """路径归一化：统一用 / 分隔、去首尾斜杠与引号。
    FileItem.path 各网盘都用 /（quark 递归拼接就是 prefix+name），
    但命令行/Windows 用户可能传 \\ 或带引号，比对前必须归一，
    否则「明明选了却匹配不上」。"""
    text = str(p or "").replace("\\", "/").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "'\"":
        text = text[1:-1].strip()
    return text.strip("/")


def parse_only(only_args):
    """--only 支持重复传参和逗号分隔，返回去重后的规范化路径列表。"""
    wanted = []
    for raw in only_args or []:
        for piece in str(raw).split(","):
            item = _norm_path(piece)
            if item and item not in wanted:
                wanted.append(item)
    return wanted


def filter_only(results, wanted):
    """按 --only 过滤解析结果。

    - 传文件名 → 精确匹配 path；
    - 传目录名 → 该目录下全部文件（前缀匹配）；
    - 返回 (保留的结果, 没匹配上的输入)。保留时维持原 results 顺序，
      避免下载顺序随用户勾选顺序乱跳（批量时看得出来的）。

    匹配不上的输入不视之为致命错误：分享在解析后被更新过、或缓存与
    实时结果不一致，都会让部分路径失效——只要还有选中的文件就该继续跑。
    """
    if not wanted:
        return results, []
    kept = [it for it in results
            if any(_norm_path(it["path"]) == w
                   or _norm_path(it["path"]).startswith(w + "/")
                   for w in wanted)]
    hit = {_norm_path(it["path"]) for it in kept}
    missing = [w for w in wanted
               if not any(h == w or h.startswith(w + "/") for h in hit)]
    return kept, missing


def _process_entry(entry, args):
    """解析（并按需下载）清单里的一条。返回统计 dict，不抛异常。

    统计字段：
      pan       网盘名（识别不出为 None）
      title     分享标题
      files     文件条目列表
      link_fail 解析阶段取链失败的文件数
      dl_ok/dl_skip/dl_fail  下载成功/跳过（已存在）/失败数
      error     这一条的整体失败原因（None 表示解析成功）
    """
    st = {"pan": None, "title": None, "files": [], "link_ok": 0,
          "link_fail": 0, "dl_ok": 0, "dl_skip": 0, "dl_fail": 0,
          "error": None, "usage": False}
    url = entry["url"]
    pwd = entry.get("pwd") or args.pwd

    r = pick_resolver(url, args.pan)
    if not r:
        msg = ("无法识别该链接属于哪个网盘。用 --list-pans 查看支持列表；"
               "或用 --pan 强制指定。")
        print("错误: %s" % msg, file=sys.stderr)
        st["error"] = msg
        return st
    st["pan"] = r.name
    print("[识别网盘] %s" % r.name)

    # ---- 凭据解析：显式参数 > 文件 > 标准输入 > 环境变量 > 本机保险库 ----
    #
    # 环境变量这一层是给 GUI / 工作台集成留的：常驻服务每次都要传 cookie，
    # 走命令行参数会把凭据暴露在进程列表里（任务管理器 / wmic / ps 都能看到，
    # 而且会被别的进程通过命令行审计抓走）。env 只在本进程环境里，同样不安全
    # 但暴露面小得多，也是图形化壳子的通行做法。
    cookie, token = args.cookie, args.token
    cred_from_vault = False
    env_cookie = (os.environ.get("PAN_COOKIE") or "").strip()
    env_token = (os.environ.get("PAN_TOKEN") or "").strip()
    if cookie == "-":
        # 批量模式下只读一次 stdin：读第二次就是空的了
        if not hasattr(args, "_stdin_cookie"):
            args._stdin_cookie = sys.stdin.read().strip() or None
        cookie = args._stdin_cookie
        if not cookie:
            print("错误: --cookie - 从标准输入读到的是空内容", file=sys.stderr)
            st["error"] = "标准输入里没有 cookie"
            st["usage"] = True
            return st
    if not cookie and args.cookie_file:
        cookie = _read_secret_file(args.cookie_file, "cookie") or None
        if cookie is None:
            st["error"] = "cookie 文件不可用"
            st["usage"] = True
            return st
    if not token and args.token_file:
        token = _read_secret_file(args.token_file, "token") or None
        if token is None:
            st["error"] = "token 文件不可用"
            st["usage"] = True
            return st

    if not cookie and env_cookie:
        cookie = env_cookie
        print("[凭据] 已从环境变量 PAN_COOKIE 读取（长度 %d）" % len(env_cookie))
    if not token and env_token:
        token = env_token
        print("[凭据] 已从环境变量 PAN_TOKEN 读取（长度 %d）" % len(env_token))

    # 验证码同理：图形界面拿到用户输入的文字后放进 env，避免中文/特殊字符被
    # shell 转义搞坏（用 argv 传中文在 Windows 代码页下还会变问号）。
    captcha_code = args.captcha_code or (os.environ.get("PAN_CAPTCHA_CODE") or "").strip() or None

    if not args.no_cred:
        saved = cred_vault.load(r.name)
        got = []
        if not cookie and saved.get("cookie"):
            cookie = saved["cookie"]
            got.append("cookie" + cred_vault.describe(cookie))
        if not token and saved.get("token"):
            token = saved["token"]
            got.append("token")
        if got:
            cred_from_vault = True
            print("[凭据] 已从保险库取出 %s：%s" % (r.name, "，".join(got)))

    if r.requires_auth and not cookie and not token and not args.guest:
        print(_auth_help(r), file=sys.stderr)

    if args.dry_run:
        print(r.dry_run_info(url))
        st["dry"] = True
        return st

    # 解析缓存（直链 TTL 缓存；key = 网盘+URL+提取码+cookie摘要，登录态变化自动失效）
    title = results = None
    ckey = None
    if not args.no_cache and r.link_ttl > 0:
        ckey = link_cache.make_key(r.name, url, pwd, cookie)
        entry_c = link_cache.get(ckey)
        if entry_c and isinstance(entry_c.get("files"), list):
            remain = max(0, int(entry_c.get("expires_at", 0) - time.time()))
            print("[缓存命中] 复用解析结果（剩余有效 %s；--no-cache 强制重新解析）"
                  % _fmt_secs(remain))
            title, results = entry_c.get("title"), entry_c["files"]

    if results is None:
        try:
            title, results = r.resolve(
                url, pwd=pwd, cookie=cookie, token=token,
                recursive=not args.no_recursive, guest=args.guest,
                captcha_code=captcha_code, captcha_png=args.captcha_png)
        except PanError as e:
            print("错误: %s" % e, file=sys.stderr)
            if cred_from_vault and _looks_auth_related(str(e)):
                # 最容易误判的一种情况：库里存的是旧登录态，报错看着像接口坏了。
                # 只在错误确实像认证问题时提示——否则「分享不存在」也会被归因到凭据上。
                print("[提示] 本次用的是保险库里的凭据，而错误看起来与登录态有关。"
                      "若是登录过期：重新从浏览器复制 Cookie 后加 --save-cred 覆盖即可"
                      "（或本次用 --no-cred --cookie \"...\" 对照验证）。",
                      file=sys.stderr)
            st["error"] = str(e)
            return st
        # 只缓存至少拿到一个直链的结果，避免把风控/失效错误缓存住
        if ckey and any((not it.get("is_dir")) and it.get("url")
                        for it in results):
            if link_cache.put(ckey, title, results, r.link_ttl):
                print("[已缓存] 解析结果缓存 %s（--no-cache 跳过）"
                      % _fmt_secs(r.link_ttl))

    st["title"], st["files"] = title, results

    # --only：只保留选中的文件。过滤点放在解析之后、所有出口（人类列表 /
    # aria2 导出与推送 / 下载 / JSON）之前，保证各处看到的是同一份选择。
    if args.only:
        wanted = parse_only(args.only)
        results, missing = filter_only(results, wanted)
        st["files"] = results
        if missing:
            print("[--only] %d 个指定路径没匹配到（分享可能已更新）：%s"
                  % (len(missing), "、".join(missing[:5])
                     + (" 等" if len(missing) > 5 else "")),
                  file=sys.stderr)
        if not any(not it.get("is_dir") for it in results):
            # 一个都没选中 = 这次运行没有意义。按用法错误退出（1）而不是
            # 「全部失败」（3）：参数指向的东西不存在，不是链接失效。
            print("错误: --only 指定的路径在解析结果里都不存在", file=sys.stderr)
            st["error"] = "--only 没有匹配到任何文件"
            st["usage"] = True
            return st
        print("[--only] 已筛选出 %d 个文件"
              % sum(1 for it in results if not it.get("is_dir")))

    # 存凭据放在成功之后：只保存确实能用的那一份，避免把过期 cookie 存进库
    if args.save_cred:
        if not cookie and not token:
            print("[凭据] 本次没有 cookie/token 可保存（--save-cred 已跳过）",
                  file=sys.stderr)
        elif cred_vault.save(r.name, cookie, token):
            print("[凭据已保存] %s → 下次可省略 --cookie（--no-cred 忽略、"
                  "--forget-cred 删除）" % r.name)
        else:
            print("[凭据] 保存失败（保险库不可写），已忽略", file=sys.stderr)

    file_total = sum(1 for it in results if not it["is_dir"])
    ok_n = sum(1 for it in results
               if not it["is_dir"] and it["url"] and not it.get("error"))
    fail_n = sum(1 for it in results
                 if not it["is_dir"] and (it.get("error") or not it["url"]))
    st["link_ok"] = ok_n
    st["link_fail"] = fail_n

    if not args.json:
        print("分享标题: %s" % (title or "(无标题)"))
        print("文件数: %d（目录 %d + 文件 %d，取链成功 %d / 失败 %d）\n"
              % (len(results), len(results) - file_total, file_total, ok_n, fail_n))
        for it in results:
            tag = "[DIR]" if it["is_dir"] else "[FILE]"
            print("%s %-12s %s" % (tag, human_size(it["size"]), it["path"]))
            if not it["is_dir"]:
                if it["url"]:
                    print("      %s" % it["url"])
                if it.get("error"):
                    print("      !! 取链失败: %s" % it["error"])

    if args.aria2:
        with open(args.aria2, "w", encoding="utf-8") as fp:
            for it in results:
                if it["is_dir"] or not it["url"]:
                    continue
                fp.write(it["url"] + "\n")
                fp.write("  dir=%s\n" % (os.path.dirname(it["path"]) or "."))
                fp.write("  out=%s\n" % os.path.basename(it["path"]))
                for k, v in r.aria2_headers(it, cookie, token).items():
                    fp.write("  header=%s: %s\n" % (k, v))
                fp.write("\n")
        print("\n已导出 aria2 输入文件: %s" % args.aria2)
        print("用法: aria2c -i %s -x 16 -s 16" % args.aria2)

    if args.aria2_rpc:
        # 直接推送给常驻 aria2（省去本工具拉流量）。单条失败不中断整批。
        rpc = Aria2RPC(args.aria2_rpc, args.aria2_secret)
        try:
            ver, feats = rpc.version()
        except Aria2Error as e:
            print("错误: %s" % e, file=sys.stderr)
            st["error"] = str(e)
            st["usage"] = True      # aria2 没起来是前提问题，不是链接问题
            return st
        push_dir = args.aria2_dir or os.getcwd()
        files = [it for it in results if not it["is_dir"] and it["url"]]
        print("\n推送 %d 个直链到 aria2（%s，v%s）→ %s"
              % (len(files), args.aria2_rpc, ver or "?", push_dir))
        ok = 0
        for it in files:
            headers = r.aria2_headers(it, cookie, token)
            hdict = dict(headers) if not isinstance(headers, dict) else headers
            try:
                rpc.add_uri(it["url"], out_dir=push_dir,
                            filename=os.path.basename(it["path"]),
                            headers=hdict)
                ok += 1
                print("  ✓ %s" % it["path"])
            except Aria2Error as e:
                print("  ✗ %s : %s" % (it["path"], e), file=sys.stderr)
        print("推送完成: %d/%d" % (ok, len(files)))

    if args.out:
        os.makedirs(args.out, exist_ok=True)
        files = [it for it in results if not it["is_dir"] and it["url"]]
        jobs = max(1, min(args.jobs, 8))
        threads = max(1, min(args.threads, 16))
        if jobs > 1 and threads > 1:
            print("提示: --jobs %d 与 --threads %d 叠加，峰值连接数最多 %d，"
                  "可能触发网盘风控" % (jobs, threads, jobs * threads))
        print("\n开始下载到 %s ...（%d 个文件，文件间并发 %d%s%s）"
              % (args.out, len(files), jobs,
                 "，单文件分块 %d 线程" % threads if threads > 1 else "",
                 "，断点续传开启" if not args.no_resume else ""))

        def _dl(it):
            it.pop("_skipped", None)
            try:
                if threads > 1:
                    # 并发时逐块进度会交错，改静默；串行保留原进度显示
                    r.download_chunked(it, args.out, threads=threads,
                                       cookie=cookie, token=token,
                                       quiet=jobs > 1,
                                       overwrite=args.overwrite,
                                       retries=args.retry)
                else:
                    r.download(it, args.out, cookie, token,
                               quiet=jobs > 1,
                               resume=not args.no_resume,
                               overwrite=args.overwrite,
                               retries=args.retry)
                return it, None
            except PanError as e:
                return it, str(e)
            except Exception as e:   # 未预期异常也不能炸整批
                return it, "未预期错误: %s" % e

        def _tally(it, err):
            if err:
                st["dl_fail"] += 1
                print("  ✗ %s : %s" % (it["path"], err), file=sys.stderr)
            elif it.get("_skipped"):
                st["dl_skip"] += 1
                print("  = %s（已存在，跳过）" % it["path"])
            else:
                st["dl_ok"] += 1
                print("  ✓ %s" % it["path"])

        if jobs > 1 and len(files) > 1:
            # 多文件并发下载（单文件失败不影响其他文件；按提交顺序汇总结果）
            import threading
            from concurrent.futures import ThreadPoolExecutor
            lock = threading.Lock()
            with ThreadPoolExecutor(max_workers=jobs) as ex:
                for it, err in ex.map(_dl, files):
                    with lock:
                        _tally(it, err)
        else:
            for it in files:
                it, err = _dl(it)
                _tally(it, err)
        print("下载完成: 成功 %d / 跳过 %d / 失败 %d（共 %d）"
              % (st["dl_ok"], st["dl_skip"], st["dl_fail"], len(files)))

    return st


def _entry_state(st):
    """单条的状态：ok / partial / fail。

    区分 partial 是为了退出码不撒谎：一个分享里 9 个文件下好、1 个 404，
    既不该报「成功」也不该报「全失败」——那是部分成功，
    脚本据此决定要不要重跑，语义必须准。
    """
    if st["usage"]:
        # 前提不满足（凭据文件读不到、aria2 连不上）：这次运行本身无效，
        # 解析出再多文件也不算成功，否则退出码会骗人。
        return "fail"
    bad = bool(st["error"] or st["link_fail"] or st["dl_fail"])
    if not bad:
        return "ok"
    produced = st["link_ok"] + st["dl_ok"] + st["dl_skip"]
    return "partial" if produced > 0 else "fail"


def _print_summary(stats, elapsed):
    """批量运行的收尾汇总（单条也打，省得回去翻滚动输出）。"""
    states = [_entry_state(s) for s in stats]
    n_ok = states.count("ok")
    n_part = states.count("partial")
    n_fail = states.count("fail")
    print("\n" + "=" * 56)
    print("汇总：%d 条，完全成功 %d / 部分成功 %d / 失败 %d，用时 %.1fs"
          % (len(stats), n_ok, n_part, n_fail, elapsed))
    marks = {"ok": "✓", "partial": "~", "fail": "✗"}
    for i, (s, state) in enumerate(zip(stats, states), 1):
        name = s["pan"] or "?"
        if state == "ok":
            extra = []
            if s["dl_ok"]:
                extra.append("下载 %d" % s["dl_ok"])
            if s["dl_skip"]:
                extra.append("跳过 %d" % s["dl_skip"])
            print("  %d. %s %-10s %s%s"
                  % (i, marks[state], name,
                     s["title"] or ("(dry-run)" if s.get("dry") else "(无标题)"),
                     "（%s）" % "，".join(extra) if extra else ""))
            continue
        reasons = []
        if s["error"]:
            reasons.append(s["error"])
        if s["link_fail"]:
            reasons.append("取链失败 %d" % s["link_fail"])
        if s["dl_fail"]:
            reasons.append("下载失败 %d" % s["dl_fail"])
        if state == "partial":
            reasons.append("（其余已成功）")
        print("  %d. %s %-10s %s"
              % (i, marks[state], name, "；".join(reasons)))
    print("=" * 56)


def main(argv=None):
    # 输出被管道/重定向时 stdout 会变成块缓冲，而 stderr 仍是行缓冲，
    # 两路混看会出现「错误先于 [识别网盘]」这种顺序错乱。强制行缓冲让它顺序稳定。
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass

    p = _ArgParser(
        description="多网盘分享直链解析统一入口（夸克/蓝奏/阿里/天翼…）")
    p.add_argument("share_url", nargs="?", help="网盘分享链接")
    p.add_argument("--from-file", metavar="PATH",
                   help="从清单文件批量解析（一行一条，# 开头为注释；"
                        "链接后跟提取码，用空格/|/制表符分隔；写 - 读标准输入）")
    p.add_argument("--pan", help="强制指定网盘（默认识别）：夸克网盘/蓝奏云/阿里云盘/天翼云盘/...")
    p.add_argument("--cookie", help="网盘登录 Cookie（写 - 则从标准输入/管道读取）")
    p.add_argument("--cookie-file", metavar="PATH",
                   help="从文件读取 Cookie（内容为一整行）")
    p.add_argument("--token", help="Bearer token（阿里云盘等）")
    p.add_argument("--token-file", metavar="PATH", help="从文件读取 token")
    p.add_argument("--save-cred", action="store_true",
                   help="成功解析后把本次生效的 cookie/token 存入本机凭据保险库")
    p.add_argument("--no-cred", action="store_true",
                   help="本次不使用保险库里已存的凭据")
    p.add_argument("--forget-cred", action="store_true",
                   help="删除该网盘已存凭据后退出（可配合 --pan 指定网盘）")
    p.add_argument("--list-creds", action="store_true",
                   help="列出保险库中的凭据（不含明文）后退出")
    p.add_argument("--clear-creds", action="store_true",
                   help="清空整个凭据保险库后退出")
    p.add_argument("--pwd", help="提取码")
    p.add_argument("--captcha-code", help="迅雷图形验证码文字（触发验证码时填入）")
    p.add_argument("--captcha-png", metavar="PATH",
                   help="迅雷验证码图片保存位置（GUI 调用：非交互时落盘后报错，"
                        "由调用方展示图片、收集文字后重试）")
    p.add_argument("--only", action="append", default=[], metavar="PATH",
                   help="只处理指定文件：可重复或用逗号分隔；传目录名表示其下"
                        "全部文件（对 --out / --aria2 / --aria2-rpc 同时生效）")
    p.add_argument("--guest", action="store_true", help="夸克游客态")
    p.add_argument("--no-recursive", action="store_true", help="不进入子目录")
    p.add_argument("--out", help="解析后直接下载到该目录")
    p.add_argument("--jobs", type=int, default=3, metavar="N",
                   help="下载并发数（文件间；1=串行；默认 3，上限 8）")
    p.add_argument("--threads", type=int, default=1, metavar="N",
                   help="单文件分块下载线程数（需服务端支持 Range；"
                        "默认 1=不分块；与 --jobs 叠加会放大连接数）")
    p.add_argument("--retry", type=int, default=2, metavar="N",
                   help="网络错误重试次数（默认 2，0=不重试；只重试超时/断流/5xx）")
    p.add_argument("--no-resume", action="store_true",
                   help="关闭断点续传（默认开启：中断后重跑从 .part 接着下）")
    p.add_argument("--overwrite", action="store_true",
                   help="覆盖已存在的同名文件（默认跳过已完成文件）")
    p.add_argument("--aria2", help="导出为 aria2 输入文件")
    p.add_argument("--aria2-rpc", metavar="URL",
                   help="推送到 aria2 RPC（如 http://127.0.0.1:6800/jsonrpc）")
    p.add_argument("--aria2-secret", help="aria2 RPC 密钥（--rpc-secret）")
    p.add_argument("--aria2-dir", help="推送时指定的 aria2 保存目录（默认当前目录）")
    p.add_argument("--json", action="store_true", help="JSON 输出")
    p.add_argument("--dry-run", action="store_true", help="只构造请求、不发网络")
    p.add_argument("--list-pans", action="store_true", help="列出支持的网盘")
    p.add_argument("--no-cache", action="store_true",
                   help="不使用解析缓存（强制重新解析）")
    p.add_argument("--clear-cache", action="store_true", help="清空解析缓存后退出")
    p.add_argument("--cache-stats", action="store_true",
                   help="查看解析缓存统计后退出")
    args = p.parse_args(argv)

    if args.list_pans:
        list_pans(args.json)
        return RET_OK

    if args.list_creds:
        list_creds()
        return RET_OK

    if args.clear_creds:
        if cred_vault.clear():
            print("已清空凭据保险库")
        else:
            print("凭据保险库为空（无需清理）")
        return RET_OK

    if args.clear_cache:
        if link_cache.clear():
            print("已清空解析缓存")
        else:
            print("解析缓存为空（无需清理）")
        return RET_OK

    if args.cache_stats:
        n, size = link_cache.stats()
        print("解析缓存: %d 条有效记录, %.1f KB" % (n, size / 1024.0))
        print("缓存文件: %s" % link_cache._cache_path())
        return RET_OK

    if args.forget_cred:
        name = args.pan
        if not name and args.share_url:
            r0 = pick_resolver(args.share_url, None)
            name = r0.name if r0 else None
        if not name:
            p.error("--forget-cred 需要分享链接或用 --pan 指定网盘名")
        if cred_vault.forget(name):
            print("已删除 %s 的已存凭据" % name)
        else:
            print("%s 没有已存凭据（无需删除）" % name)
        return RET_OK

    # ---- 组装待处理条目：单条 or 清单 ----
    if args.from_file:
        try:
            entries, warns = batch.load_list(args.from_file)
        except OSError as e:
            print("错误: 读取清单失败（%s）：%s" % (args.from_file, e),
                  file=sys.stderr)
            return RET_USAGE
        for w in warns:
            print("[清单] 第 %d 行: %s" % (w["line"], w["message"]),
                  file=sys.stderr)
        if not entries:
            print("错误: 清单里没有可用的链接：%s" % args.from_file,
                  file=sys.stderr)
            return RET_USAGE
        raw_n = len(entries)
        entries, dup_n = batch.dedupe(entries)
        if dup_n:
            print("[清单] 读到 %d 行有效链接，去重后 %d 条（跳过 %d 条重复）"
                  % (raw_n, len(entries), dup_n))
        else:
            print("[清单] 读到 %d 条链接" % len(entries))
        if args.share_url:
            print("[提示] 已指定 --from-file，命令行上的分享链接被忽略",
                  file=sys.stderr)
    else:
        if not args.share_url:
            p.error("缺少分享链接（或用 --from-file 传清单、--list-pans 查看支持的网盘）")
        entries = [{"url": args.share_url, "pwd": args.pwd, "line": 0}]

    multi = len(entries) > 1
    stats = []
    t0 = time.time()
    json_out = []
    for i, e in enumerate(entries, 1):
        if multi:
            print("\n" + "-" * 56)
            print("[%d/%d] %s%s" % (i, len(entries), e["url"],
                                    "（提取码 %s）" % e["pwd"] if e["pwd"] else ""))
            print("-" * 56)
        st = _process_entry(e, args)
        stats.append(st)
        if args.json and st["files"] is not None:
            json_out.append({
                "pan": st["pan"], "title": st["title"],
                "files": [{k: v for k, v in it.items() if not k.startswith("_")}
                          for it in st["files"]],
            })

    if args.json:
        # 内部协作字段（_fid/_drive_id 等下划线开头）不进 JSON 输出；
        # 单条保持原结构（向后兼容），多条包成数组
        payload = json_out[0] if (len(json_out) == 1 and not multi) else json_out
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    elif multi or not args.dry_run:
        _print_summary(stats, time.time() - t0)

    if not stats:
        return RET_FAIL
    states = [_entry_state(s) for s in stats]
    if all(x == "ok" for x in states):
        return RET_OK
    if all(x == "fail" for x in states):
        # 一条都没解析出来。再分一层：全是「前提不满足」（凭据文件读不到、
        # aria2 连不上）算用法错误 1，否则是链接/网络失败 3。
        # 分开的意义：脚本能区分「我参数给错了」和「链接失效了」。
        if all(s["usage"] for s in stats):
            return RET_USAGE
        return RET_FAIL
    return RET_PARTIAL



if __name__ == "__main__":
    sys.exit(main())
