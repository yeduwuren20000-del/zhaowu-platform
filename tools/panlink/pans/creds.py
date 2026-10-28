#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本机凭据保险库（cookie / token 免重复粘贴）
==========================================
痛点：百度、115、移动、迅雷这些网盘的登录 Cookie 动辄几百字符，每次解析都要去
开发者工具里复制粘贴一遍，既烦又容易粘漏。

做法：把「网盘 → {cookie, token}」存在本机，加密后落盘；下次解析同一网盘时
若没显式给 --cookie，自动取出来用。

加密（零依赖）
--------------
- Windows：**DPAPI**（`CryptProtectData` / `CryptUnprotectData`，user scope）。
  直接 ctypes 调 crypt32.dll，不需要 pywin32。密文与「当前 Windows 用户」绑定，
  拷到别的账号/机器上解不开——即使文件被同步或备份泄露，也拿不到明文。
- 其他平台：明文存储 + 文件权限 0600（chmod），并在 `backend()` 里如实报告
  `"plain"`，不假装加密。

设计（与 cache.py 一致：失败静默、绝不阻塞主流程）
------------------------------------------------
- 存储：单个 JSON 文件，默认 `~/.config/yunx-pans/credentials.json`
  （环境变量 YUNX_CRED_DIR 覆盖，测试/便携场景用）；
- 每条：`{name: {enc, data, updated_at, preview, backend}}`，
  data 是 base64(密文)；解密后 payload = {cookie, token}；
- preview 只记「cookie 有几个键、键名、总长度」，**不记录任何值**，
  供 `--list-creds` 展示，避免明文泄露；
- 原子写（tmp + os.replace）；文件损坏/解密失败一律当作「没有凭据」，
  让调用方回退到提示用户手动给 cookie。

⚠️ 仍然属于敏感数据：DPAPI 只保证「别的用户/别的机器解不开」，
当前用户自己的进程（含本工具）是能解开的。所以不要把文件内容贴到任何地方。
"""

import base64
import json
import os
import sys
import tempfile
import time

CRED_VERSION = 1
_ENTROPY = b"yunx-pans-credentials-v1"
_DPAPI_UI_FORBIDDEN = 0x1


# --------------------------------------------------------------------------
# 平台加密层
# --------------------------------------------------------------------------

class _DataBlob(object):
    """ctypes 包装的 DATA_BLOB（延迟构造，非 Windows 不导入 ctypes）。"""
    pass


def _ctypes_blob(data):
    """把 bytes 包成 DATA_BLOB，返回 (blob, buffer)。buffer 需保持存活。"""
    import ctypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", ctypes.c_uint32),
                    ("pbData", ctypes.POINTER(ctypes.c_char))]

    buf = ctypes.create_string_buffer(data, len(data))
    blob = DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    return blob, buf, DATA_BLOB


def _dpapi(data, protect):
    """调用 DPAPI 加密/解密；不可用或失败返回 None。"""
    if not sys.platform.startswith("win"):
        return None
    try:
        import ctypes
        blob_in, _buf, DATA_BLOB = _ctypes_blob(data)
        ent_in, _entbuf, _ = _ctypes_blob(_ENTROPY)
        blob_out = DATA_BLOB()
        fn = ("CryptProtectData" if protect else "CryptUnprotectData")
        call = getattr(ctypes.windll.crypt32, fn)
        # (pDataIn, desc/name, entropy, reserved, prompt, flags, pDataOut)
        ok = call(ctypes.byref(blob_in), None, ctypes.byref(ent_in), None, None,
                  _DPAPI_UI_FORBIDDEN, ctypes.byref(blob_out))
        if not ok:
            return None
        try:
            return ctypes.string_at(blob_out.pbData, blob_out.cbData)
        finally:
            ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    except Exception:
        return None


def backend():
    """返回当前实际的加密后端名：'dpapi' 或 'plain'。

    通过「加密一次再解回来」实测判定，不看平台名字——这样在 DPAPI 被策略禁用
    的机器上也不会谎报成加密。
    """
    probe = b"yunx-probe"
    blob = _dpapi(probe, True)
    if blob and _dpapi(blob, False) == probe:
        return "dpapi"
    return "plain"


def _protect(plain, be):
    raw = plain.encode("utf-8")
    if be == "dpapi":
        blob = _dpapi(raw, True)
        if blob:
            return {"enc": "dpapi", "data": base64.b64encode(blob).decode("ascii")}
        # DPAPI 突然不可用 → 退回明文，避免直接丢数据（backend 会如实报告）
        be = "plain"
    return {"enc": "plain", "data": base64.b64encode(raw).decode("ascii")}


def _unprotect(rec):
    """解密一条记录；失败返回 None（调用方视为无凭据）。"""
    if not isinstance(rec, dict):
        return None
    enc = rec.get("enc")
    try:
        blob = base64.b64decode(rec.get("data") or "")
    except Exception:
        return None
    if enc == "dpapi":
        raw = _dpapi(blob, False)
        if raw is None:
            return None          # 换了用户/机器，或 DPAPI 被禁用
    elif enc == "plain":
        raw = blob
    else:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return None


# --------------------------------------------------------------------------
# 存储层
# --------------------------------------------------------------------------

def _cred_dir():
    return os.environ.get("YUNX_CRED_DIR") or os.path.join(
        os.path.expanduser("~"), ".config", "yunx-pans")


def _path():
    return os.path.join(_cred_dir(), "credentials.json")


def _load_raw():
    """读取保险库；不存在/损坏/版本不符都返回 {}（绝不抛异常）。"""
    try:
        with open(_path(), "r", encoding="utf-8") as fp:
            data = json.load(fp)
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict) or data.get("version") != CRED_VERSION:
        return {}
    entries = data.get("entries")
    return entries if isinstance(entries, dict) else {}


def _save_raw(entries):
    """原子写 + 尽量收紧权限；失败返回 False。"""
    try:
        os.makedirs(_cred_dir(), exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".creds-", suffix=".tmp",
                                   dir=_cred_dir())
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fp:
                json.dump({"version": CRED_VERSION, "entries": entries},
                          fp, ensure_ascii=False, indent=1)
            os.replace(tmp, _path())
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        try:
            os.chmod(_path(), 0o600)
        except OSError:
            pass              # Windows 上 chmod 语义有限，DPAPI 已经兜住
        return True
    except Exception:
        return False


# --------------------------------------------------------------------------
# 对外 API
# --------------------------------------------------------------------------

def describe(secret):
    """生成「不含任何值」的摘要，如 `cookie（BDUSS, STOKEN，共 412 字符）`。"""
    if not secret:
        return ""
    names = []
    for part in secret.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        k = part.split("=", 1)[0].strip()
        if k and k not in names:
            names.append(k)
    if not names:
        return "已设置（%d 字符）" % len(secret)
    shown = ", ".join(names[:4]) + ("…" if len(names) > 4 else "")
    return "（%s，共 %d 字符）" % (shown, len(secret))


def save(name, cookie=None, token=None):
    """保存/更新某网盘的凭据。两者都为空时不写（返回 False）。"""
    if not name or (not cookie and not token):
        return False
    be = backend()
    payload = {}
    if cookie:
        payload["cookie"] = cookie
    if token:
        payload["token"] = token
    rec = _protect(json.dumps(payload, ensure_ascii=False), be)
    rec["updated_at"] = time.time()
    rec["backend"] = be
    rec["preview"] = {
        "cookie": describe(cookie) if cookie else "",
        "token": ("（%d 字符）" % len(token)) if token else "",
    }
    entries = _load_raw()
    entries[name] = rec
    return _save_raw(entries)


def load(name):
    """取某网盘凭据，返回 {"cookie":..., "token":...}（缺失的键不存在）。

    不存在/解密失败/结构不对 → 返回 {}。
    """
    if not name:
        return {}
    rec = _load_raw().get(name)
    payload = _unprotect(rec)
    if not isinstance(payload, dict):
        return {}
    out = {}
    if isinstance(payload.get("cookie"), str) and payload["cookie"]:
        out["cookie"] = payload["cookie"]
    if isinstance(payload.get("token"), str) and payload["token"]:
        out["token"] = payload["token"]
    return out


def forget(name):
    """删除某网盘凭据。返回是否真的删了。"""
    entries = _load_raw()
    if name not in entries:
        return False
    del entries[name]
    if not entries:
        # 库空了就连文件一起删，避免留下一个空壳文件（也让 clear() 的语义
        # 与「有没有东西可清」一致）
        clear()
        return True
    return _save_raw(entries)


def entries():
    """列出所有条目（不含明文），按更新时间倒序。

    返回 [{name, has_cookie, has_token, updated_at, backend, preview}]。
    只用磁盘上的元信息，不做解密——列清单不需要解密，也就不会因为
    换用户/换机器而报错。
    """
    rows = []
    for name, rec in _load_raw().items():
        if not isinstance(rec, dict):
            continue
        preview = rec.get("preview") or {}
        rows.append({
            "name": name,
            "has_cookie": bool(preview.get("cookie")),
            "has_token": bool(preview.get("token")),
            "updated_at": rec.get("updated_at") or 0,
            "backend": rec.get("backend") or "?",
            "preview": preview,
        })
    rows.sort(key=lambda r: r["updated_at"], reverse=True)
    return rows


def clear():
    """删掉整个保险库文件。返回是否删掉了。"""
    try:
        if os.path.exists(_path()):
            os.unlink(_path())
            return True
    except OSError:
        pass
    return False


def fmt_age(ts):
    """把时间戳格式化成「3 天前」这类相对时间。"""
    if not ts:
        return "未知时间"
    delta = max(0, time.time() - ts)
    if delta < 90:
        return "刚刚"
    if delta < 3600:
        return "%d 分钟前" % (delta // 60)
    if delta < 86400:
        return "%d 小时前" % (delta // 3600)
    return "%d 天前" % (delta // 86400)
