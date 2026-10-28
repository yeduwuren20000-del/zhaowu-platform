import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useToast } from '../hooks/useToast.mjs';
import { LogPanel, normalizeTextLines } from './LogPanel.mjs';
import { Button, EmptyState, ErrorNotice, Notice } from './ui.mjs';
import { formatBytes, formatDateTime, timeAgo } from '../utils/format.js';

/**
 * 远程日志查看：**只能**读取服务器配置里预先登记的 logPaths，
 * 没有命令输入框，路径用下拉选择；读取走只读通道（SFTP）。
 */
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function ServerLogViewer({
  server,
  onEditServer
}) {
  const toast = useToast();
  const allowed = server.logPaths || [];
  const [selected, setSelected] = useState('');
  const [entries, setEntries] = useState([]);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState(null);
  const load = useCallback(async path => {
    if (allowed.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.serverLog(server.id, path || allowed[0], 300);
      setEntries(normalizeTextLines(result.lines));
      setInfo(result);
    } catch (err) {
      setError(err.message);
      setEntries([]);
      setInfo(null);
    } finally {
      setLoading(false);
    }
  }, [allowed, server.id]);
  useEffect(() => {
    if (allowed.length > 0) {
      setSelected(allowed[0]);
      load(allowed[0]);
    } else {
      setEntries([]);
      setInfo(null);
    }
  }, [allowed, load]);
  async function checkPaths() {
    setChecking(true);
    try {
      const result = await api.serverLogCheck(server.id);
      setCheckResult(result.paths || []);
    } catch (err) {
      toast.error('检查日志路径失败', err.message);
    } finally {
      setChecking(false);
    }
  }
  if (allowed.length === 0) {
    return /*#__PURE__*/_jsx(EmptyState, {
      title: "\u8FD8\u6CA1\u6709\u914D\u7F6E\u53EF\u8BFB\u65E5\u5FD7\u8DEF\u5F84",
      hint: "\u4E3A\u907F\u514D\u4EFB\u610F\u547D\u4EE4\u6267\u884C\uFF0C\u53EA\u5141\u8BB8\u8BFB\u53D6\u9884\u5148\u767B\u8BB0\u7684\u6587\u4EF6\u3002\u8BF7\u5728\u300C\u7F16\u8F91\u670D\u52A1\u5668\u300D\u91CC\u586B\u5199\u65E5\u5FD7\u8DEF\u5F84\uFF0C\u4F8B\u5982 /var/log/nginx/error.log\u3002",
      action: /*#__PURE__*/_jsx(Button, {
        variant: "primary",
        icon: "edit",
        onClick: () => onEditServer?.(server),
        children: "\u53BB\u914D\u7F6E\u65E5\u5FD7\u8DEF\u5F84"
      })
    });
  }
  return /*#__PURE__*/_jsxs("div", {
    children: [/*#__PURE__*/_jsxs("div", {
      className: "row row--wrap",
      style: {
        marginBottom: 10,
        gap: 8
      },
      children: [/*#__PURE__*/_jsx("select", {
        className: "select",
        style: {
          maxWidth: 340
        },
        value: selected,
        onChange: event => setSelected(event.target.value),
        children: allowed.map(item => /*#__PURE__*/_jsx("option", {
          value: item,
          children: item
        }, item))
      }), /*#__PURE__*/_jsx(Button, {
        size: "sm",
        icon: "fileText",
        loading: loading,
        onClick: () => load(selected),
        children: "\u8BFB\u53D6"
      }), /*#__PURE__*/_jsx(Button, {
        size: "sm",
        icon: "check",
        loading: checking,
        onClick: checkPaths,
        children: "\u68C0\u67E5\u8DEF\u5F84"
      }), /*#__PURE__*/_jsx("div", {
        className: "spacer"
      }), /*#__PURE__*/_jsx("span", {
        style: {
          fontSize: 11.5,
          color: 'var(--muted-2)'
        },
        children: info ? `${info.lines.length} 行 · ${formatBytes(info.size)} · 修改于 ${formatDateTime(info.mtime)}` : '只读读取（SFTP），不会在服务器上执行你输入的任意命令'
      })]
    }), checkResult ? /*#__PURE__*/_jsx("div", {
      className: "footnote",
      style: {
        marginBottom: 8
      },
      children: checkResult.map(item => /*#__PURE__*/_jsxs("span", {
        style: {
          marginRight: 14
        },
        children: [/*#__PURE__*/_jsx("span", {
          className: item.exists ? 'status-word muted' : 'status-word is-error',
          children: item.exists ? '存在' : '不存在'
        }), ' ', /*#__PURE__*/_jsx("span", {
          className: "tech",
          children: item.path
        })]
      }, item.path))
    }) : null, error ? /*#__PURE__*/_jsx(ErrorNotice, {
      error: error,
      onRetry: () => load().catch(() => {}),
      retryLabel: "\u91CD\u65B0\u8BFB\u53D6"
    }) : null, server.logRead?.error && !error && entries.length === 0 ? /*#__PURE__*/_jsxs(Notice, {
      tone: "warn",
      icon: "alert",
      children: ["\u4E0A\u6B21\u8BFB\u53D6\u5931\u8D25\uFF08", timeAgo(server.logRead.at), "\uFF09\uFF1A", server.logRead.error]
    }) : null, /*#__PURE__*/_jsx(LogPanel, {
      entries: entries,
      height: 340,
      emptyText: "\u8FD9\u4E2A\u65E5\u5FD7\u6587\u4EF6\u8FD8\u6CA1\u6709\u53EF\u8BFB\u5185\u5BB9\u3002"
    })]
  });
}