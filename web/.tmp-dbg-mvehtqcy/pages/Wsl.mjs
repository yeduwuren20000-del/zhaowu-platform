import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { Icon } from '../components/Icons.mjs';
import { Button, Card, EmptyState, ErrorNotice, Loading, Notice } from '../components/ui.mjs';
import { PageHint } from '../components/PageHint.mjs';
import { timeAgo } from '../utils/format.js';

/**
 * WSL 页面：只做"看得见"——把每个 WSL 发行版里在监听的服务列出来。
 *
 * 为什么要单独做一页：WSL2 有独立网络命名空间，里面监听的服务
 * 在 Windows 侧完全查不到（实测 ss 显示 LISTEN 0.0.0.0:18099，
 * 而 Get-NetTCPConnection 一片空白）。所以这里只能主动进发行版去问。
 *
 * 不做启停：WSL 只读，不执行任何控制命令。
 */
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
export function WslPage() {
  const [data, setData] = useState(null);
  const [available, setAvailable] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showProcesses, setShowProcesses] = useState(false);
  const [at, setAt] = useState(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [avail, result] = await Promise.all([api.wslAvailable(), api.wslCollect(showProcesses)]);
      setAvailable(avail);
      setData(result);
      setAt(new Date().toISOString());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [showProcesses]);
  useEffect(() => {
    load();
  }, [load]);
  const results = data?.results || [];
  const totalPorts = results.reduce((sum, item) => sum + (item.ports?.length || 0), 0);
  return /*#__PURE__*/_jsxs("div", {
    className: "page",
    children: [/*#__PURE__*/_jsxs("div", {
      className: "page__header",
      children: [/*#__PURE__*/_jsx("div", {
        className: "page__title",
        children: "WSL"
      }), /*#__PURE__*/_jsxs("div", {
        className: "page__actions",
        children: [/*#__PURE__*/_jsx(Button, {
          icon: showProcesses ? 'eye' : 'eye-off',
          onClick: () => setShowProcesses(p => !p),
          children: showProcesses ? '隐藏进程' : '显示进程'
        }), /*#__PURE__*/_jsx(Button, {
          icon: "refresh",
          loading: loading,
          onClick: load,
          children: "\u5237\u65B0"
        })]
      })]
    }), /*#__PURE__*/_jsx(PageHint, {
      id: "wsl",
      icon: "box",
      children: "WSL2 \u6709\u72EC\u7ACB\u7684\u7F51\u7EDC\uFF0C\u91CC\u9762\u76D1\u542C\u7684\u670D\u52A1\u5728 Windows \u4FA7\u67E5\u4E0D\u5230\uFF0C\u6240\u4EE5\u8981\u5355\u72EC\u8FDB\u6765\u95EE\u4E00\u6B21\u3002\u8FD9\u91CC\u662F\u53EA\u8BFB\u67E5\u770B\uFF0C\u4E0D\u4F1A\u5BF9 WSL \u6267\u884C\u4EFB\u4F55\u542F\u505C\u547D\u4EE4\u3002"
    }), available && available.available === false ? /*#__PURE__*/_jsx(Notice, {
      tone: "warn",
      icon: "alert",
      children: available.reason
    }) : null, error ? /*#__PURE__*/_jsx(ErrorNotice, {
      error: error,
      onRetry: () => load().catch(() => {})
    }) : null, loading && !data ? /*#__PURE__*/_jsx(Loading, {
      text: "\u6B63\u5728\u8FDB\u5165 WSL \u53D1\u884C\u7248\u91C7\u96C6\u2026"
    }) : results.length === 0 ? /*#__PURE__*/_jsx(Card, {
      children: /*#__PURE__*/_jsx(EmptyState, {
        title: "\u6CA1\u6709\u627E\u5230 WSL \u53D1\u884C\u7248",
        hint: "\u5148\u5728 PowerShell \u91CC\u6267\u884C wsl --list --installable \u770B\u770B\uFF0C\u6216\u7528 wsl --install \u5B89\u88C5\u3002"
      })
    }) : /*#__PURE__*/_jsxs(_Fragment, {
      children: [/*#__PURE__*/_jsxs("div", {
        className: "wsl-summary",
        children: [/*#__PURE__*/_jsxs("span", {
          children: [results.length, " \u4E2A\u53D1\u884C\u7248 \xB7 ", totalPorts, " \u4E2A\u76D1\u542C\u7AEF\u53E3"]
        }), /*#__PURE__*/_jsx("span", {
          className: "footnote",
          children: at ? `采集于 ${timeAgo(at)}` : ''
        })]
      }), results.map(item => /*#__PURE__*/_jsxs(Card, {
        title: item.name,
        icon: "terminal",
        subtitle: item.ok ? `${item.ports.length} 个端口` : '无数据',
        actions: /*#__PURE__*/_jsxs("span", {
          className: "footnote",
          children: [item.durationMs, "ms"]
        }),
        flush: true,
        children: [item.error && !item.ok ? /*#__PURE__*/_jsx("div", {
          style: {
            padding: 12
          },
          children: /*#__PURE__*/_jsx(Notice, {
            tone: "warn",
            icon: "alert",
            children: item.error
          })
        }) : null, item.ports.length === 0 ? /*#__PURE__*/_jsx("div", {
          style: {
            padding: 12
          },
          children: /*#__PURE__*/_jsx("span", {
            className: "muted",
            children: "\u8FD9\u4E2A\u53D1\u884C\u7248\u91CC\u5F53\u524D\u6CA1\u6709\u5BF9\u5916\u76D1\u542C\u7684\u7AEF\u53E3\u3002"
          })
        }) : /*#__PURE__*/_jsxs("table", {
          className: "table",
          children: [/*#__PURE__*/_jsx("thead", {
            children: /*#__PURE__*/_jsxs("tr", {
              children: [/*#__PURE__*/_jsx("th", {
                children: "\u7AEF\u53E3"
              }), /*#__PURE__*/_jsx("th", {
                children: "\u76D1\u542C\u5730\u5740"
              }), /*#__PURE__*/_jsx("th", {
                children: "\u8FDB\u7A0B"
              }), /*#__PURE__*/_jsx("th", {
                children: "\u547D\u4EE4\u884C"
              })]
            })
          }), /*#__PURE__*/_jsx("tbody", {
            children: item.ports.map(port => /*#__PURE__*/_jsxs("tr", {
              children: [/*#__PURE__*/_jsx("td", {
                className: "table__port",
                children: port.port
              }), /*#__PURE__*/_jsx("td", {
                className: "tech",
                children: port.address || '*'
              }), /*#__PURE__*/_jsxs("td", {
                children: [/*#__PURE__*/_jsx("span", {
                  className: "tech",
                  children: port.processName || '—'
                }), port.pid ? /*#__PURE__*/_jsxs("span", {
                  className: "muted",
                  children: [" PID ", port.pid]
                }) : null]
              }), /*#__PURE__*/_jsx("td", {
                className: "tech muted wsl-cmd",
                children: port.commandLine || '—'
              })]
            }, `${port.port}-${port.address}`))
          })]
        }), showProcesses && item.processes.length > 0 ? /*#__PURE__*/_jsxs("details", {
          className: "wsl-procs",
          children: [/*#__PURE__*/_jsxs("summary", {
            children: ["\u5168\u90E8\u8FDB\u7A0B\uFF08", item.processes.length, "\uFF09"]
          }), /*#__PURE__*/_jsx("div", {
            className: "wsl-procs__list",
            children: item.processes.map(proc => /*#__PURE__*/_jsxs("div", {
              className: "wsl-procs__row",
              children: [/*#__PURE__*/_jsx("span", {
                className: "tech muted",
                children: proc.pid
              }), /*#__PURE__*/_jsx("span", {
                className: "tech",
                children: proc.processName
              }), /*#__PURE__*/_jsx("span", {
                className: "muted",
                children: proc.commandLine
              })]
            }, proc.pid))
          })]
        }) : null]
      }, item.name)), /*#__PURE__*/_jsxs(Notice, {
        tone: "info",
        icon: "info",
        children: ["WSL2 \u6709\u72EC\u7ACB\u7684\u7F51\u7EDC\u547D\u540D\u7A7A\u95F4\uFF0C\u8FD9\u4E9B\u7AEF\u53E3\u5728 Windows \u4FA7\u7684\u300C\u670D\u52A1\u7AEF\u53E3\u300D\u9875\u91CC", /*#__PURE__*/_jsx("b", {
          children: "\u770B\u4E0D\u5230"
        }), "\uFF0C\u5C5E\u4E8E\u6B63\u5E38\u73B0\u8C61\u3002 \u8FD9\u91CC\u662F\u53EA\u8BFB\u67E5\u770B\uFF0C\u4E0D\u4F1A\u5BF9 WSL \u6267\u884C\u4EFB\u4F55\u542F\u505C\u547D\u4EE4\u3002"]
      })]
    })]
  });
}
export default WslPage;