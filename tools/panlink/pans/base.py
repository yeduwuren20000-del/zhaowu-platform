#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
多网盘解析统一框架 —— 抽象基类与共享数据结构
============================================
所有网盘 provider 都继承 PanResolver，实现各自的链接识别与解析逻辑。
设计目标：把 YunX(夸克) 那套「解析分享 → 列文件 → 取直链」模式，复用给各大网盘。

统一文件结构 FileItem（每个网盘 resolve 后都返回这种 dict 列表）：
    {
        "path":  "相对保存路径（含文件名）",
        "name":  "文件名",
        "size":  int（字节，目录可为 0）,
        "is_dir": bool,
        "url":   "最终可下载直链（目录为 None）",
        "headers": { 下载/导出时需携带的额外请求头，如 Referer/Cookie/Authorization },
    }
"""

import abc
import os
import socket
import sys
import time


class PanError(Exception):
    """所有 provider 统一抛出的异常类型。"""
    pass


class ShortRead(Exception):
    """流读到一半就断了（期望 total 字节，实得 partial）。

    独立于 PanError 是有意的：PanError 属于「不可重试的业务失败」
    （分享失效、风控、无直链），而 ShortRead 是纯网络问题，
    必须允许重试——且重试时能靠已落盘的 .part 续传，不用重头下。
    """

    def __init__(self, partial, expected):
        Exception.__init__(self, "传输中断（已收 %d / %d 字节）"
                           % (partial, expected))
        self.partial = partial
        self.expected = expected


#: 可重试的错误类型。**白名单而非黑名单**：文件系统错误（磁盘满、
#: 权限不足）也在 OSError 家族里，一律重试只会把「没权限」拖成
#: 三重超时。HTTP 只有 5xx/408/429 值得重试，4xx 是请求本身的问题。
def is_retryable(exc):
    import http.client
    import urllib.error
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code >= 500 or exc.code in (408, 429)
    if isinstance(exc, ShortRead):
        return True
    if isinstance(exc, urllib.error.URLError):
        return True
    if isinstance(exc, (ConnectionError, TimeoutError, socket.timeout,
                        socket.gaierror, http.client.IncompleteRead,
                        http.client.BadStatusLine)):
        return True
    return False


def with_retry(fn, retries=2, backoff=1.0, on_retry=None):
    """执行 fn()，遇到可重试错误按指数退避重试。

    ``retries`` 是**额外**重试次数（1 表示总共最多跑 2 次）。
    不可重试的异常立即抛出，不浪费时间。
    """
    attempt = 0
    while True:
        try:
            return fn()
        except Exception as e:
            if attempt >= retries or not is_retryable(e):
                raise
            attempt += 1
            delay = backoff * (2 ** (attempt - 1))
            if on_retry:
                on_retry(attempt, retries, e, delay)
            time.sleep(delay)



class PanResolver(abc.ABC):
    """网盘解析器抽象基类。子类需实现 name / match / resolve。"""

    #: 网盘中文名 / 标识
    name = "通用网盘"
    #: 是否需要登录凭据（cookie / token）。True 时 CLI 会要求 --cookie 或 --token
    requires_auth = False
    #: 凭据类型提示（cookie / token），用于 CLI 提示
    auth_hint = ""
    #: 解析结果（含直链）的缓存 TTL（秒）。直链会过期，TTL 必须保守：
    #: 按各网盘直链有效期取值（百度 4h、移动 15min、阿里官方 5min…），
    #: 详见 LinkSwift 对照研究的缓存策略。置 0 表示不缓存。
    link_ttl = 1800

    @abc.abstractmethod
    def match(self, url):
        """返回 True/False：该分享链接是否属于本网盘。"""
        raise NotImplementedError

    @abc.abstractmethod
    def resolve(self, url, pwd=None, cookie=None, token=None,
                recursive=True, dry_run=False, **opts):
        """
        解析分享链接，返回 (title, [FileItem, ...])。
        title 为分享标题（可为 None）。
        FileItem 见模块顶部说明。
        """
        raise NotImplementedError

    # ----------------- 以下为可覆盖的默认行为（基类提供通用实现）-----------------

    def download(self, item, out_dir, cookie=None, token=None, quiet=False,
                 resume=True, overwrite=False, retries=2):
        """用 item["url"] + item["headers"] 下载单个文件。

        - ``overwrite=False`` 时，目标文件已存在且大小相符 → 直接跳过
          （批量重跑不会白下已完成的部分），跳过会在 item 上留
          ``_skipped=True`` 供调用方统计；大小未知时也按「已完成」处理，
          只有 ``--overwrite`` 才会重下。
        - ``resume=True`` 时边下边写 ``<dest>.part``，支持断点续传：服务器
          返回 206 就从已落盘位置接着写，返回 200（不认 Range）则从头来。
          只有完整收齐才 ``os.replace`` 成目标名，所以中途失败不会留下
          「看着像完成」的半截文件。
        - ``retries`` 次网络重试（退避 1s/2s/4s），重试会自动续传已有的 .part。

        完整性以**响应头的 Content-Length** 为准，不拿 ``item["size"]`` 当判据：
        网盘返回的 size 元数据并不总准（WebDAV 类接口常给 0 或旧值），
        用元数据校验会把「其实下载成功」变成永远失败。元数据只用于跳过
        已存在文件的快速判断，以及没有 Content-Length 时的进度显示。
        """
        from . import http
        url = item["url"]
        if not url:
            raise PanError("该条目无下载直链（可能是目录）")
        rel = item["path"]
        dest = os.path.join(out_dir, rel)
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        headers = dict(item.get("headers") or {})
        total = item.get("size") or 0
        part = dest + ".part"

        if not overwrite and os.path.isfile(dest):
            have = os.path.getsize(dest)
            # have >= total：元数据偏小时不该判成「未完成」而重下
            if not total or have >= total:
                item["_skipped"] = True
                if not quiet:
                    sys.stderr.write("跳过（已存在）: %s\n" % rel)
                    sys.stderr.flush()
                return dest

        if not quiet:
            sys.stderr.write("下载: %s\n" % rel)
            sys.stderr.flush()

        def _attempt():
            start = 0
            if resume and not overwrite and os.path.isfile(part):
                have = os.path.getsize(part)
                if total and have >= total:
                    # 按元数据已经够了（含元数据偏小的情况）→ 当作完成
                    os.replace(part, dest)
                    return
                start = have
            if start:
                resp = http.stream_get_range(url, start, headers)
                if resp.getcode() != 206:
                    # 服务端不认 Range（返回 200 全量）→ 只能从头来
                    resp.close()
                    start = 0
                    resp = http.stream_get(url, headers=headers, timeout=60)
            else:
                resp = http.stream_get(url, headers=headers, timeout=60)

            # 期望的最终字节数 = 本次起点 + 响应声明的长度。
            # 206+Range 到末尾时正好等于全文件大小；200 时就是全量大小。
            # 拿不到 Content-Length（chunked 传输）就退回元数据、再不行就不校验。
            expect_end = None
            cl = resp.headers.get("Content-Length")
            if cl and str(cl).strip().isdigit():
                expect_end = start + int(cl)
            disp_total = expect_end or total

            done = start
            last = time.time()
            fp = open(part, "ab" if start else "wb")
            try:
                while True:
                    buf = resp.read(1 << 16)
                    if not buf:
                        break
                    fp.write(buf)
                    done += len(buf)
                    now = time.time()
                    if not quiet and (now - last > 0.5
                                      or (disp_total and done >= disp_total)):
                        pct = (done / disp_total * 100) if disp_total else 0
                        sys.stderr.write("\r  %s  %d/%d  %.1f%%"
                                         % (rel, done, disp_total, pct))
                        sys.stderr.flush()
                        last = now
            finally:
                try:
                    fp.close()
                finally:
                    try:
                        resp.close()
                    except Exception:
                        pass
            if not quiet:
                sys.stderr.write("\n")
                sys.stderr.flush()
            if expect_end:
                got = os.path.getsize(part) if os.path.exists(part) else 0
                if got < expect_end:
                    # 断流：抛可重试异常，下一轮靠 .part 续传接着写
                    raise ShortRead(got, expect_end)
            os.replace(part, dest)

        def _on_retry(n, tries, exc, delay):
            sys.stderr.write("  ! 网络问题，第 %d/%d 次重试（%s；%.0fs 后%s）\n"
                             % (n, tries, exc, delay,
                                "续传" if os.path.exists(part) else "重下"))
            sys.stderr.flush()

        try:
            with_retry(_attempt, retries=retries, on_retry=_on_retry)
        except PanError:
            raise
        except ShortRead as e:
            raise PanError("%s（已保留 %s，重跑可续传）" % (e, os.path.basename(part)))
        except Exception as e:
            raise PanError("下载失败（%s）：%s" % (type(e).__name__, e))
        return dest

    def aria2_headers(self, item, cookie=None, token=None):
        """返回给 aria2 的额外 header 行（不含 dir/out，由 CLI 统一写）。"""
        return [(k, v) for k, v in (item.get("headers") or {}).items()]

    def download_chunked(self, item, out_dir, threads=4, cookie=None,
                         token=None, quiet=False, min_size=8 << 20,
                         overwrite=False, retries=2):
        """单文件多线程分块下载（HTTP Range）。
        - 先探测服务端是否支持 Range；不支持 / 文件小于 min_size →
          自动回退 self.download() 单线程流式；
        - 支持 → 均分 threads 块（上限 16），各线程写 <dest>.partN，
          校验每块大小后按序拼接，原子替换成 dest；
        - 任一块失败 / 大小不符 → 清理全部 part，抛 PanError（不留半个
          文件冒充成功，调用方的 per-file 隔离会记 error）；
        - ``overwrite=False`` 时目标已存在且大小相符直接跳过（同 download）；
        - 单块失败按 ``retries`` 自动重试该块，不影响其他块。
        """
        from . import http
        url = item["url"]
        if not url:
            raise PanError("该条目无下载直链（可能是目录）")
        rel = item["path"]
        dest = os.path.join(out_dir, rel)
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        headers = dict(item.get("headers") or {})

        total = item.get("size") or 0
        if not overwrite and os.path.isfile(dest):
            have = os.path.getsize(dest)
            if not total or have == total:
                item["_skipped"] = True
                if not quiet:
                    sys.stderr.write("跳过（已存在）: %s\n" % rel)
                    sys.stderr.flush()
                return dest
        probe = http.probe_range(url, headers)
        if not probe.get("ok") or (total and total < min_size):
            # 小文件或不支持 Range：分块无收益，直接单线程
            return self.download(item, out_dir, cookie, token, quiet=quiet,
                               overwrite=overwrite, retries=retries)
        if probe.get("total"):
            total = probe["total"]
        if not total or total < min_size:
            return self.download(item, out_dir, cookie, token, quiet=quiet,
                               overwrite=overwrite, retries=retries)

        n = max(1, min(threads, 16))
        step = total // n
        if step <= 0:
            return self.download(item, out_dir, cookie, token, quiet=quiet,
                               overwrite=overwrite, retries=retries)
        bounds = []
        for i in range(n):
            s = i * step
            e = total - 1 if i == n - 1 else (s + step - 1)
            bounds.append((s, e))

        if not quiet:
            sys.stderr.write("分块下载: %s（%d 块，每块约 %s）\n"
                             % (rel, n, human_size(step)))
            sys.stderr.flush()

        parts = [dest + ".part%d" % i for i in range(n)]
        errors = []

        def _fetch_one(i):
            s, e = bounds[i]
            resp = http.open_range(url, s, e, headers)
            try:
                with open(parts[i], "wb") as fp:
                    while True:
                        buf = resp.read(1 << 16)
                        if not buf:
                            break
                        fp.write(buf)
            finally:
                resp.close()
            # 块内校验：长度不符按可重试错误处理，只重下这一块，
            # 而不是让整批都作废（原来只有外层校验，一块断流就要全部分块重来）
            got = os.path.getsize(parts[i]) if os.path.exists(parts[i]) else 0
            if got != e - s + 1:
                raise ShortRead(got, e - s + 1)

        def _fetch(i):
            try:
                with_retry(lambda: _fetch_one(i), retries=retries)
            except Exception as ex:  # 任一块失败都记录，最后统一判定
                errors.append((i, ex))

        try:
            if n > 1:
                import threading
                ths = [threading.Thread(target=_fetch, args=(i,))
                       for i in range(n)]
                for t in ths:
                    t.start()
                for t in ths:
                    t.join()
            else:
                _fetch(0)
            if errors:
                raise PanError("分块下载失败（块 %d）: %s"
                               % (errors[0][0], errors[0][1]))
            for i, (s, e) in enumerate(bounds):
                got = os.path.getsize(parts[i]) if os.path.exists(parts[i]) else 0
                if got != e - s + 1:
                    raise PanError("分块 %d 大小不符（期望 %d 实得 %d）"
                                   % (i, e - s + 1, got))
            # 拼接到临时文件再原子替换，中途失败不会留下半个 dest
            cat = dest + ".cat"
            with open(cat, "wb") as out:
                for p in parts:
                    with open(p, "rb") as fp:
                        while True:
                            buf = fp.read(1 << 20)
                            if not buf:
                                break
                            out.write(buf)
            os.replace(cat, dest)
        finally:
            for p in parts:
                try:
                    if os.path.exists(p):
                        os.unlink(p)
                except OSError:
                    pass
        return dest

    def dry_run_info(self, url):
        """返回一段描述「将如何请求」的字符串，供 --dry-run 展示。默认空。"""
        return ""


def human_size(n):
    n = float(n or 0)
    for u in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or u == "TB":
            return "%.1f%s" % (n, u)
        n /= 1024


def isolate(fn, *args, **kwargs):
    """执行单个文件的取链/下载，失败时返回 (None, 错误信息) 而不抛出。
    用于批量场景：单文件失败不中断整批（LinkSwift 同款 per-file 隔离思想）。
    返回 (结果, None) 或 (None, 错误串)。"""
    try:
        return fn(*args, **kwargs), None
    except PanError as e:
        return None, str(e)
    except Exception as e:  # 未预期错误也隔离，保证整批继续
        return None, "未预期错误: %s" % e


def batch_throttle(index, batch, total, sleep_seconds=1.0):
    """批量节流：每处理完一批（非最后一批）sleep 一下，规避网盘风控频次。
    LinkSwift 各网盘同款策略（百度 50/批、多数 15/批、批间 sleep 1s）。"""
    if index + batch < total and sleep_seconds > 0:
        time.sleep(sleep_seconds)
