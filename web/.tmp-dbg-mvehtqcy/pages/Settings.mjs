import { useState } from 'react';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { useToast } from '../hooks/useToast.mjs';
import { Button, Card, ConfirmDialog, Loading, Notice } from '../components/ui.mjs';
import { PageHint } from '../components/PageHint.mjs';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function SettingsPage() {
  const toast = useToast();
  const {
    data,
    loading,
    reload
  } = useAsync(() => api.settings(), {
    deps: []
  });
  const [confirm, setConfirm] = useState(null);
  const [working, setWorking] = useState(false);
  async function run(action, fn) {
    setWorking(true);
    try {
      await fn();
      setConfirm(null);
      await reload();
    } catch (error) {
      toast.error(`${action}失败`, error.message);
    } finally {
      setWorking(false);
    }
  }
  return /*#__PURE__*/_jsxs("div", {
    className: "page",
    children: [/*#__PURE__*/_jsxs("div", {
      className: "page__header",
      children: [/*#__PURE__*/_jsx("div", {
        className: "page__title",
        children: "\u8BBE\u7F6E"
      }), /*#__PURE__*/_jsx("div", {
        className: "page__actions",
        children: /*#__PURE__*/_jsx(Button, {
          icon: "refresh",
          loading: loading,
          onClick: () => reload().catch(() => {}),
          children: "\u5237\u65B0"
        })
      })]
    }), /*#__PURE__*/_jsx(PageHint, {
      id: "settings",
      icon: "settings",
      children: "\u6240\u6709\u6570\u636E\u90FD\u662F\u660E\u6587 JSON\uFF0C\u5B58\u5728\u300C\u6570\u636E\u76EE\u5F55\u300D\u91CC\uFF0C\u53EF\u4EE5\u76F4\u63A5\u5907\u4EFD\u6216\u7EB3\u5165 Git\u3002\u641E\u4E71\u4E86\u53EF\u4EE5\u300C\u6062\u590D\u793A\u4F8B\u6570\u636E\u300D\uFF08\u539F\u6587\u4EF6\u4F1A\u5148\u5907\u4EFD\uFF09\u3002"
    }), /*#__PURE__*/_jsxs("div", {
      className: "grid",
      style: {
        gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)'
      },
      children: [/*#__PURE__*/_jsx(Card, {
        title: "\u6570\u636E\u4E0E\u8DEF\u5F84",
        icon: "database",
        children: loading && !data ? /*#__PURE__*/_jsx(Loading, {}) : /*#__PURE__*/_jsxs("div", {
          className: "kv",
          children: [/*#__PURE__*/_jsx("span", {
            className: "kv__key",
            children: "\u6570\u636E\u76EE\u5F55"
          }), /*#__PURE__*/_jsx("span", {
            className: "kv__value",
            children: data?.dataDir
          }), /*#__PURE__*/_jsx("span", {
            className: "kv__key",
            children: "\u65E5\u5FD7\u76EE\u5F55"
          }), /*#__PURE__*/_jsx("span", {
            className: "kv__value",
            children: data?.logDir
          }), /*#__PURE__*/_jsx("span", {
            className: "kv__key",
            children: "\u9879\u76EE\u8BB0\u5F55\u6587\u4EF6"
          }), /*#__PURE__*/_jsx("span", {
            className: "kv__value",
            children: data?.files?.projects
          }), /*#__PURE__*/_jsx("span", {
            className: "kv__key",
            children: "\u670D\u52A1\u5668\u8BB0\u5F55\u6587\u4EF6"
          }), /*#__PURE__*/_jsx("span", {
            className: "kv__value",
            children: data?.files?.servers
          }), /*#__PURE__*/_jsx("span", {
            className: "kv__key",
            children: "\u8FD0\u884C\u6001\u6587\u4EF6"
          }), /*#__PURE__*/_jsx("span", {
            className: "kv__value",
            children: data?.files?.runtime
          }), /*#__PURE__*/_jsx("span", {
            className: "kv__key",
            children: "\u5DE5\u4F5C\u53F0\u4E8B\u4EF6\u65E5\u5FD7"
          }), /*#__PURE__*/_jsx("span", {
            className: "kv__value",
            children: data?.files?.workbenchLog
          }), /*#__PURE__*/_jsx("span", {
            className: "kv__key",
            children: "\u524D\u7AEF\u6784\u5EFA\u76EE\u5F55"
          }), /*#__PURE__*/_jsxs("span", {
            className: "kv__value",
            children: [data?.webDistDir, " ", data?.webDistExists ? '（已构建）' : '（未构建，开发模式走 Vite 5180）']
          })]
        })
      }), /*#__PURE__*/_jsx(Card, {
        title: "\u8FD0\u884C\u73AF\u5883",
        icon: "cpu",
        children: loading && !data ? /*#__PURE__*/_jsx(Loading, {}) : /*#__PURE__*/_jsxs("div", {
          className: "kv",
          style: {
            gridTemplateColumns: '112px minmax(0, 1fr)'
          },
          children: [/*#__PURE__*/_jsx("span", {
            className: "kv__key",
            children: "API \u7AEF\u53E3"
          }), /*#__PURE__*/_jsx("span", {
            className: "kv__value",
            children: data?.apiPort
          }), /*#__PURE__*/_jsx("span", {
            className: "kv__key",
            children: "Node \u7248\u672C"
          }), /*#__PURE__*/_jsx("span", {
            className: "kv__value",
            children: data?.node
          }), /*#__PURE__*/_jsx("span", {
            className: "kv__key",
            children: "\u5E73\u53F0"
          }), /*#__PURE__*/_jsx("span", {
            className: "kv__value",
            children: data?.platform
          }), /*#__PURE__*/_jsx("span", {
            className: "kv__key",
            children: "\u4E3B\u673A\u540D"
          }), /*#__PURE__*/_jsx("span", {
            className: "kv__value",
            children: data?.hostname
          }), /*#__PURE__*/_jsx("span", {
            className: "kv__key",
            children: "\u670D\u52A1\u8FDB\u7A0B PID"
          }), /*#__PURE__*/_jsx("span", {
            className: "kv__value",
            children: data?.pid
          })]
        })
      })]
    }), /*#__PURE__*/_jsxs(Card, {
      title: "\u7EF4\u62A4\u64CD\u4F5C",
      icon: "settings",
      children: [/*#__PURE__*/_jsxs("div", {
        className: "row row--wrap",
        style: {
          gap: 10
        },
        children: [/*#__PURE__*/_jsx(Button, {
          icon: "folderOpen",
          onClick: () => run('打开数据目录', () => api.openDataDir()),
          children: "\u6253\u5F00\u6570\u636E\u76EE\u5F55"
        }), /*#__PURE__*/_jsx(Button, {
          icon: "refresh",
          onClick: () => run('重置运行态', async () => {
            const result = await api.resetRuntime();
            toast.success('运行态已重置', `清理了 ${result.dropped.length} 条已失效的 PID 记录`);
          }),
          children: "\u91CD\u7F6E\u8FD0\u884C\u6001"
        }), /*#__PURE__*/_jsx(Button, {
          variant: "danger",
          icon: "alert",
          onClick: () => setConfirm('reseed'),
          children: "\u6062\u590D\u793A\u4F8B\u6570\u636E"
        })]
      }), /*#__PURE__*/_jsxs(Notice, {
        tone: "info",
        icon: "shield",
        children: ["\u6570\u636E\u4EE5 JSON \u660E\u6587\u4FDD\u5B58\u5728 ", /*#__PURE__*/_jsx("span", {
          className: "mono",
          children: data?.dataDir
        }), "\uFF0C\u53EF\u4EE5\u76F4\u63A5\u5907\u4EFD\u3001\u624B\u6539\u6216\u7EB3\u5165 Git\uFF08\u5DF2\u5728 .gitignore \u4E2D\u5FFD\u7565\uFF09\u3002"]
      })]
    }), /*#__PURE__*/_jsx(ConfirmDialog, {
      open: confirm === 'reseed',
      title: "\u6062\u590D\u793A\u4F8B\u6570\u636E",
      message: "\u4F1A\u5220\u9664\u5F53\u524D\u7684 projects.json / servers.json / runtime.json\uFF08\u539F\u6587\u4EF6\u91CD\u547D\u540D\u5907\u4EFD\uFF09\uFF0C\u5E76\u5199\u56DE\u793A\u4F8B\u6570\u636E\u3002",
      confirmText: "\u786E\u8BA4\u6062\u590D",
      loading: working,
      onClose: () => setConfirm(null),
      onConfirm: () => run('恢复示例数据', async () => {
        await api.reseed();
        toast.success('已恢复示例数据', '原文件已备份保留在数据目录中');
      })
    })]
  });
}