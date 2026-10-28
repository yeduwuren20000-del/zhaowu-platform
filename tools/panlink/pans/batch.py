#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
批量清单解析（`pan.py --from-file`）
=====================================
把「一堆分享链接」交给一次运行，避免 shell 里反复调用。

支持的行格式（每行一条，顺序无关）::

    # 整行注释（也接受 // 开头）
    https://pan.quark.cn/s/aaaa
    https://pan.baidu.com/s/1bbbb  abcd          # 空格分隔提取码
    https://pan.quark.cn/s/cccc|efgh             # 竖线分隔
    https://www.123pan.com/s/dddd	1234          # 制表符分隔（从表格粘贴）

设计取舍
--------
* **不做行内注释**：115/移动云盘的分享链接里会出现 ``#``
  （如 ``https://yun.139.com/w/#/share/XXX``），把 ``#`` 当注释开头
  会把合法链接截断。注释只支持整行，避免这种歧义。
* 文件按 ``utf-8-sig`` 读，自动吃掉 Excel/记事本存盘带的 BOM，
  否则第一行链接会变成 ``\\ufeffhttps://...`` 而识别失败。
* 提取码做形状校验（1~12 位字母数字），形状不对只警告不致命——
  宁可不传提取码让网盘报错，也不要把半截链接当密码传下去。
"""

import sys

#: 注释行前缀
COMMENT_PREFIXES = ("#", "//")

#: 字段分隔符（按优先级）：竖线、制表符。空格在各分隔符之后单独处理，
#: 因为「空格分隔」只在 URL 不含空格时才成立（URL 确实不含裸空格）。
_SEPARATORS = ("|", "\t")

#: 提取码最大长度。各网盘实际为 4 位，留余量到 12。
_MAX_PWD_LEN = 12


def _clean_token(s):
    """去掉包裹的引号与两端空白（含全角空格/制表符）。"""
    s = (s or "").strip().strip("\u3000").strip()
    for q in ('"', "'", "`", "\u201c", "\u201d", "\u2018", "\u2019"):
        if len(s) >= 2 and s.startswith(q) and s.endswith(q):
            s = s[1:-1].strip()
    return s


def _looks_like_pwd(s):
    """提取码形状校验：1~12 位字母数字。"""
    if not s or len(s) > _MAX_PWD_LEN:
        return False
    return s.isalnum()


def split_line(line):
    """把一行拆成 (url, pwd)。pwd 可能为 None。"""
    for sep in _SEPARATORS:
        if sep in line:
            left, right = line.split(sep, 1)
            return _clean_token(left), _clean_token(right) or None
    parts = line.split()
    if len(parts) >= 2:
        return _clean_token(parts[0]), _clean_token(" ".join(parts[1:])) or None
    return _clean_token(line), None


def parse_list(text, require_http=True):
    """解析清单文本。

    返回 ``(entries, warnings)``：
      entries  —— ``[{"url": str, "pwd": str|None, "line": int}]``
      warnings —— ``[{"line": int, "message": str}]``（不致命，调用方决定是否打印）
    """
    entries, warnings = [], []
    for lineno, raw in enumerate((text or "").splitlines(), 1):
        line = raw.strip().lstrip("\ufeff").strip()
        if not line:
            continue
        if line.startswith(COMMENT_PREFIXES):
            continue
        url, pwd = split_line(line)
        if not url:
            warnings.append({"line": lineno, "message": "空链接，已忽略"})
            continue
        if require_http and not url.lower().startswith(("http://", "https://")):
            warnings.append({"line": lineno,
                             "message": "不是 http(s) 链接，已忽略：%s"
                                        % (url[:40] + ("…" if len(url) > 40 else ""))})
            continue
        if pwd is not None and not _looks_like_pwd(pwd):
            warnings.append({"line": lineno,
                             "message": "提取码形状可疑（%r），已按无提取码处理" % pwd})
            pwd = None
        entries.append({"url": url, "pwd": pwd, "line": lineno})
    return entries, warnings


def load_list(path):
    """从文件读清单；``path`` 为 ``-`` 时读标准输入。"""
    if path == "-":
        return parse_list(sys.stdin.read())
    with open(path, "r", encoding="utf-8-sig", errors="replace") as fp:
        return parse_list(fp.read())


def dedupe(entries):
    """按 (url, pwd) 去重，保留首次出现的行号。返回 ``(unique, dropped)``。

    重复解析同一个分享只会多吃一次风控，所以批量模式默认去重；
    同一个链接配不同提取码视为不同条目（可能指向不同内容）。
    """
    seen, unique = set(), []
    dropped = 0
    for e in entries:
        key = (e["url"], e.get("pwd") or "")
        if key in seen:
            dropped += 1
            continue
        seen.add(key)
        unique.append(e)
    return unique, dropped
