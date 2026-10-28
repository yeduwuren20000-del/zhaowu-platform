import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAsync, usePolling } from '../hooks/useAsync.js';
import { useToast } from '../hooks/useToast.mjs';
import { PortTable } from '../components/PortTable.mjs';
import { PageHint } from '../components/PageHint.mjs';
import { statusMeta } from '../utils/format.js';
import { Button, Card, ErrorNotice, Notice, SearchBox, SkeletonList, Switch, Tabs } from '../components/ui.mjs';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function PortsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const {
    data,
    loading,
    error,
    reload
  } = useAsync(() => api.ports(true), {
    deps: []
  });
  const [env, setEnv] = useState('all');
  const [query, setQuery] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  useEffect(() => {
    if (location.state?.q) setQuery(location.state.q);
  }, [location.state]);
  usePolling(() => reload().catch(() => {}), 15000, autoRefresh);
  const rows = data?.rows || [];
  const conflicts = data?.conflicts || [];
  const stats = data?.stats;
  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    return rows.filter(row => {
      if (env !== 'all' && row.envKey !== env) return false;
      if (!text) return true;
      return [row.port, row.app, row.owner, row.path, row.host, row.statusText, statusMeta(row.status).text, row.env, row.processName].filter(value => value !== null && value !== undefined).some(value => String(value).toLowerCase().includes(text));
    });
  }, [rows, env, query]);
  async function scanPort(port) {
    try {
      return await api.scanPort(port);
    } catch (err) {
      toast.error('端口查询失败', err.message);
      return null;
    }
  }
  function openUrl(url) {
    if (!url) return;
    window.open(url, '_blank', 'noopener');
  }
  async function copyPath(path) {
    if (!path) {
      toast.warn('这条记录没有路径', '可以在编辑里补上部署路径');
      return;
    }
    try {
      await navigator.clipboard.writeText(path);
      toast.success('已复制到剪贴板', path);
    } catch {
      toast.warn('浏览器拒绝了剪贴板访问', '请手动复制：' + path);
    }
  }
  return /*#__PURE__*/_jsxs("div", {
    className: "page",
    children: [/*#__PURE__*/_jsxs("div", {
      className: "page__header",
      children: [/*#__PURE__*/_jsx("div", {
        className: "page__title",
        children: "\u670D\u52A1\u7AEF\u53E3"
      }), /*#__PURE__*/_jsxs("div", {
        className: "page__actions",
        children: [/*#__PURE__*/_jsx(Switch, {
          checked: autoRefresh,
          onChange: setAutoRefresh,
          label: "\u81EA\u52A8\u5237\u65B0"
        }), /*#__PURE__*/_jsx(Button, {
          icon: "refresh",
          loading: loading,
          onClick: () => reload().catch(() => {}),
          children: "\u5237\u65B0"
        })]
      })]
    }), /*#__PURE__*/_jsx(PageHint, {
      id: "ports",
      icon: "ports",
      children: "\u6240\u6709\u76D1\u542C\u7AEF\u53E3\u548C\u767B\u8BB0\u8BB0\u5F55\u90FD\u5728\u8FD9\u3002\u542F\u52A8\u62A5\u300C\u7AEF\u53E3\u88AB\u5360\u300D\u65F6\u6765\u8FD9\u91CC\u770B\u662F\u8C01\u5360\u7684\u3001\u5BF9\u5E94\u54EA\u4E2A\u9879\u76EE\uFF0C\u80FD\u76F4\u63A5\u8DF3\u8FC7\u53BB\u5904\u7406\u3002"
    }), /*#__PURE__*/_jsxs("div", {
      className: "toolbar",
      children: [/*#__PURE__*/_jsx(Tabs, {
        value: env,
        onChange: setEnv,
        options: [{
          value: 'all',
          label: '全部',
          count: stats?.total ?? rows.length
        }, {
          value: 'local',
          label: '本地',
          count: stats?.local ?? 0
        }, {
          value: 'server',
          label: '服务器',
          count: stats?.server ?? 0
        }]
      }), /*#__PURE__*/_jsx(SearchBox, {
        value: query,
        onChange: setQuery,
        placeholder: "\u641C\u7D22\u7AEF\u53E3 / APP / \u9879\u76EE / \u8DEF\u5F84\u2026",
        width: 300
      }), /*#__PURE__*/_jsx("div", {
        className: "spacer"
      }), /*#__PURE__*/_jsxs("span", {
        className: "footnote",
        children: ["\u8FD0\u884C\u4E2D ", stats?.running ?? 0, " \xB7 \u51B2\u7A81 ", stats?.conflicts ?? 0]
      })]
    }), error ? /*#__PURE__*/_jsx(ErrorNotice, {
      error: error,
      onRetry: () => reload().catch(() => {})
    }) : null, conflicts.length > 0 ? /*#__PURE__*/_jsxs(Notice, {
      tone: "warn",
      icon: "alert",
      children: [/*#__PURE__*/_jsxs("div", {
        style: {
          fontWeight: 600,
          marginBottom: 4
        },
        children: ["\u53D1\u73B0 ", conflicts.length, " \u5904\u7AEF\u53E3\u51B2\u7A81"]
      }), conflicts.map((conflict, index) => /*#__PURE__*/_jsxs("div", {
        children: ["\xB7 ", conflict.message]
      }, `${conflict.port}-${index}`))]
    }) : null, /*#__PURE__*/_jsx(Card, {
      flush: true,
      children: loading && !data ? /*#__PURE__*/_jsx(SkeletonList, {
        rows: 6
      }) : /*#__PURE__*/_jsx(PortTable, {
        rows: filtered,
        onScan: scanPort,
        onOpenUrl: openUrl,
        onCopyPath: copyPath,
        onOpenProject: projectId => navigate('/projects', {
          state: {
            focus: projectId
          }
        })
      })
    })]
  });
}