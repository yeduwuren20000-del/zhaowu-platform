#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
aria2 RPC 推送（零依赖，仅 urllib/json）
======================================
把解析出的直链直接推给本机（或远程）常驻的 aria2，由 aria2 负责下载，
省去本工具自己拉流量。JSON-RPC 2.0 over HTTP，协议参考 aria2 官方文档。

用法前提：aria2 以 `--enable-rpc --rpc-listen-port=6800` 启动
（设了 `--rpc-secret` 的话把密钥传给 `--aria2-secret`）。

设计：
- secret 用 aria2 规范的 `token:<secret>` 前缀放在 params[0]；
- 每条直链带 headers/dir/out 推送，防盗链直链（夸克/天翼等）才能下；
- 连接失败 / 认证失败 / 单条失败都有中文可读错误，单条失败不中断整批。
"""

import json
import socket
import urllib.error
import urllib.request


class Aria2Error(Exception):
    """aria2 RPC 层统一异常。"""
    pass


# aria2 RPC 几乎总是本机/局域网地址，必须绕过硬编码或环境变量里的 HTTP 代理
# （否则请求会被代理客户端拦走，连 127.0.0.1 都返回 502）。直连为主。
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Aria2RPC:
    def __init__(self, endpoint="http://127.0.0.1:6800/jsonrpc",
                 secret=None, timeout=15):
        self.endpoint = endpoint
        self.secret = secret
        self.timeout = timeout
        self._id = 0

    def _call(self, method, params):
        self._id += 1
        call_params = list(params)
        if self.secret:
            # aria2 规范：secret 以 "token:" 前缀作为 params[0]
            call_params = ["token:%s" % self.secret] + call_params
        payload = {"jsonrpc": "2.0", "id": "wb-%d" % self._id,
                   "method": method, "params": call_params}
        req = urllib.request.Request(
            self.endpoint, data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"}, method="POST")
        try:
            resp = _opener.open(req, timeout=self.timeout)
            raw = resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:200]
            raise Aria2Error("aria2 RPC 返回 HTTP %s：%s" % (e.code, body))
        except urllib.error.URLError as e:
            raise Aria2Error(
                "连不上 aria2 RPC（%s）：%s。请确认 aria2 已启动且带 "
                "--enable-rpc（端口默认 6800）。" % (self.endpoint, e.reason))
        except (socket.timeout, TimeoutError):
            raise Aria2Error(
                "连接 aria2 RPC 超时（%s，%ds）。请确认地址端口正确、"
                "aria2 已启动且带 --enable-rpc。" % (self.endpoint, self.timeout))
        except (OSError, ValueError) as e:
            raise Aria2Error("aria2 RPC 通信失败：%s" % e)
        try:
            data = json.loads(raw)
        except ValueError:
            raise Aria2Error("aria2 RPC 响应不是 JSON：%s" % raw[:200])
        if not isinstance(data, dict):
            raise Aria2Error("aria2 RPC 响应格式异常：%s" % raw[:200])
        if data.get("error"):
            err = data["error"]
            msg = err.get("message") if isinstance(err, dict) else str(err)
            raise Aria2Error("aria2 拒绝：%s" % (msg or err))
        return data.get("result")

    def version(self):
        """连接自检。返回 (version, enabled_features)。"""
        r = self._call("aria2.getVersion", []) or {}
        return r.get("version"), r.get("enabledFeatures") or []

    def add_uri(self, url, out_dir=None, filename=None, headers=None):
        """推送一条直链。headers 为 dict；Referer 合并进去。
        成功返回 gid。"""
        opts = {}
        if out_dir:
            opts["dir"] = out_dir
        if filename:
            opts["out"] = filename
        hs = []
        for k, v in (headers or {}).items():
            hs.append("%s: %s" % (k, v))
        if hs:
            opts["header"] = hs
        return self._call("aria2.addUri", [[url], opts])
