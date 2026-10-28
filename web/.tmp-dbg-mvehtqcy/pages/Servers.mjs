import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAsync, usePolling } from '../hooks/useAsync.js';
import { useServerActions } from '../hooks/useServerActions.js';
import { useToast } from '../hooks/useToast.mjs';
import { AppFormModal, ServerFormModal } from '../components/forms.mjs';
import { ServerRow } from '../components/ServerRow.mjs';
import { ServerDetail } from '../components/ServerDetail.mjs';
import { AutoMonitorPanel } from '../components/AutoMonitorPanel.mjs';
import { PageHint } from '../components/PageHint.mjs';
import { Button, ConfirmDialog, EmptyState, ErrorNotice, SearchBox, SkeletonList, Switch, Tabs } from '../components/ui.mjs';
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
export function ServersPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const {
    data: servers,
    loading,
    error,
    reload
  } = useAsync(() => api.servers(), {
    deps: []
  });
  const actions = useServerActions(reload);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  // 默认开启：数据自己会保鲜，用户不必惦记"要不要刷新"。
  // 代价很低——后端 staleMs 去重，且只采"过期"的服务器。
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [tab, setTab] = useState('overview');
  const [serverForm, setServerForm] = useState({
    open: false,
    initial: null
  });
  const [appForm, setAppForm] = useState({
    open: false,
    server: null,
    initial: null
  });
  const [submitting, setSubmitting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [pendingAppDelete, setPendingAppDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    const state = location.state;
    if (!state || !servers) return;
    if (state.create) setServerForm({
      open: true,
      initial: null
    });
    if (state.addAppFor) {
      const server = servers.find(item => item.id === state.addAppFor);
      if (server) setAppForm({
        open: true,
        server,
        initial: null
      });
    }
    if (state.focus) {
      setSelectedId(state.focus);
      window.setTimeout(() => {
        document.querySelector(`[data-server-id="${state.focus}"]`)?.scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        });
      }, 220);
    }
    if (state.q) setQuery(state.q);
    navigate(location.pathname, {
      replace: true,
      state: null
    });
  }, [location.state, location.pathname, navigate, servers]);

  // 打开自动刷新时，只做"过期数据"的低频采集（60 秒），避免频繁登录服务器
  usePolling(() => {
    api.sshProbeAll(false, 60000).then(result => result?.probed > 0 ? reload() : null).catch(() => {});
  }, 60000, autoRefresh);

  // 首次进入：若存在"从没采集过 / 数据很旧"的服务器，静默采一次。
  // 目的：打开页面就有数据，不用先想"我是不是得点一下 SSH 检测"。
  // 后端 staleMs=120s 保证不会连着刷新；同一浏览器会话只做一次（probedRef）。
  const probedOnOpenRef = useRef(false);
  useEffect(() => {
    if (probedOnOpenRef.current || !servers || servers.length === 0) return;
    const stale = servers.some(server => {
      if (server.monitorEnabled === false) return false;
      const at = server.monitoredAt || server.monitor?.at;
      return !at || Date.now() - Date.parse(at) > 120000;
    });
    if (!stale) return;
    probedOnOpenRef.current = true;
    api.sshProbeAll(false, 120000).then(result => result?.probed > 0 ? reload() : null).catch(() => {});
  }, [servers, reload]);
  const counts = useMemo(() => {
    const list = servers || [];
    return {
      all: list.length,
      online: list.filter(server => server.monitor?.online).length,
      offline: list.filter(server => server.monitor?.at && !server.monitor.online).length,
      unregistered: list.filter(server => (server.auditSummary?.listeningNotRecorded || 0) > 0).length
    };
  }, [servers]);
  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    const list = servers || [];
    return list.filter(server => {
      if (filter === 'online' && !server.monitor?.online) return false;
      if (filter === 'offline' && !(server.monitor?.at && !server.monitor.online)) return false;
      if (filter === 'unregistered' && !((server.auditSummary?.listeningNotRecorded || 0) > 0)) return false;
      if (!text) return true;
      return [server.name, server.host, server.os, server.remark, server.sshPort, server.username].filter(value => value !== null && value !== undefined).some(value => String(value).toLowerCase().includes(text));
    });
  }, [servers, query, filter]);

  // 没有选中项时默认展开第一台，详情页始终有内容
  const selected = useMemo(() => filtered.find(server => server.id === selectedId) || filtered[0] || null, [filtered, selectedId]);
  async function handleServerSubmit(payload) {
    setSubmitting(true);
    try {
      if (serverForm.initial?.id) {
        await api.updateServer(serverForm.initial.id, payload);
        toast.success('服务器已更新', payload.name);
      } else {
        await api.createServer(payload);
        toast.success('服务器已新增', `${payload.name}（${payload.host}）`);
      }
      setServerForm({
        open: false,
        initial: null
      });
      await reload();
    } catch (err) {
      toast.error('保存失败', err.message);
    } finally {
      setSubmitting(false);
    }
  }
  async function handleAppSubmit(payload) {
    if (!appForm.server) return;
    setSubmitting(true);
    try {
      if (appForm.initial?.id) {
        await api.updateServerApp(appForm.server.id, appForm.initial.id, payload);
        toast.success('应用记录已更新', payload.name);
      } else {
        await api.createServerApp(appForm.server.id, payload);
        toast.success('应用记录已新增', `${payload.name}${payload.port ? ` · 端口 ${payload.port}` : ''}`);
      }
      setAppForm({
        open: false,
        server: null,
        initial: null
      });
      await reload();
    } catch (err) {
      toast.error('保存失败', err.message);
    } finally {
      setSubmitting(false);
    }
  }
  async function handleDeleteServer() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteServer(pendingDelete.id);
      toast.success('服务器记录已删除', pendingDelete.name);
      setPendingDelete(null);
      await reload();
    } catch (err) {
      toast.error('删除失败', err.message);
    } finally {
      setDeleting(false);
    }
  }
  async function handleDeleteApp() {
    if (!pendingAppDelete) return;
    setDeleting(true);
    try {
      await api.deleteServerApp(pendingAppDelete.server.id, pendingAppDelete.app.id);
      toast.success('应用记录已删除', pendingAppDelete.app.name);
      setPendingAppDelete(null);
      await reload();
    } catch (err) {
      toast.error('删除失败', err.message);
    } finally {
      setDeleting(false);
    }
  }
  async function sshProbeAll() {
    const result = await actions.sshProbeAll();
    if (result?.failed > 0) setFilter('all');
  }
  return /*#__PURE__*/_jsxs("div", {
    className: "page",
    children: [/*#__PURE__*/_jsxs("div", {
      className: "page__header",
      children: [/*#__PURE__*/_jsx("div", {
        className: "page__title",
        children: "\u670D\u52A1\u5668"
      }), /*#__PURE__*/_jsxs("div", {
        className: "page__actions",
        children: [/*#__PURE__*/_jsx(Switch, {
          checked: autoRefresh,
          onChange: setAutoRefresh,
          label: "\u9875\u9762\u8F6E\u8BE2(60s)"
        }), /*#__PURE__*/_jsx(Button, {
          icon: "refresh",
          loading: loading,
          onClick: () => reload().catch(() => {}),
          children: "\u5237\u65B0"
        }), /*#__PURE__*/_jsx(Button, {
          variant: "primary",
          icon: "wifi",
          loading: actions.isBusy('all:ssh'),
          onClick: sshProbeAll,
          children: "\u5168\u90E8 SSH \u68C0\u6D4B"
        }), /*#__PURE__*/_jsx(Button, {
          icon: "plus",
          onClick: () => setServerForm({
            open: true,
            initial: null
          }),
          children: "\u65B0\u589E\u670D\u52A1\u5668"
        })]
      })]
    }), /*#__PURE__*/_jsx(PageHint, {
      id: "servers",
      icon: "server",
      children: "\u6DFB\u52A0 SSH \u670D\u52A1\u5668\u540E\uFF0C\u5DE5\u4F5C\u53F0\u53EA\u8BFB\u91C7\u96C6 CPU / \u5185\u5B58 / \u78C1\u76D8 / \u76D1\u542C\u7AEF\u53E3\uFF0C\u5E76\u4E0E\u767B\u8BB0\u7684 APP \u505A\u7AEF\u53E3\u6838\u5BF9\u3002\u5BC6\u7801\u8D70\u73AF\u5883\u53D8\u91CF\u4E0D\u843D\u76D8\uFF0C\u79C1\u94A5\u53EA\u5B58\u8DEF\u5F84\u3002"
    }), /*#__PURE__*/_jsx(AutoMonitorPanel, {
      onChanged: () => reload().catch(() => {})
    }), /*#__PURE__*/_jsxs("div", {
      className: "toolbar",
      children: [/*#__PURE__*/_jsx(Tabs, {
        value: filter,
        onChange: setFilter,
        options: [{
          value: 'all',
          label: '全部',
          count: counts.all
        }, {
          value: 'online',
          label: '在线',
          count: counts.online
        }, {
          value: 'offline',
          label: '离线',
          count: counts.offline
        }, {
          value: 'unregistered',
          label: '未登记端口',
          count: counts.unregistered
        }].filter(item => item.value === 'all' || item.count > 0 || item.value === filter)
      }), /*#__PURE__*/_jsx(SearchBox, {
        value: query,
        onChange: setQuery,
        placeholder: "\u641C\u7D22\u670D\u52A1\u5668 / IP / \u5E94\u7528 / \u8DEF\u5F84\u2026",
        width: 280
      }), /*#__PURE__*/_jsx("div", {
        className: "spacer"
      }), /*#__PURE__*/_jsxs("span", {
        className: "footnote",
        children: ["\u5728\u7EBF ", counts.online, "/", counts.all]
      })]
    }), error ? /*#__PURE__*/_jsx(ErrorNotice, {
      error: error,
      onRetry: () => reload().catch(() => {})
    }) : null, loading && !servers ? /*#__PURE__*/_jsx("div", {
      className: "card",
      children: /*#__PURE__*/_jsx(SkeletonList, {
        rows: 4
      })
    }) : filtered.length === 0 ? /*#__PURE__*/_jsx("div", {
      className: "card card--empty",
      children: /*#__PURE__*/_jsx(EmptyState, {
        title: query || filter !== 'all' ? '没有匹配的服务器' : '还没有添加服务器',
        hint: query || filter !== 'all' ? '换个关键字或筛选条件试试。' : '添加服务器后，工作台会通过 SSH 只读采集 CPU / 内存 / 磁盘 / 监听端口，并与你登记的 APP 做端口核对。',
        action: query || filter !== 'all' ? null : /*#__PURE__*/_jsxs("div", {
          className: "row",
          style: {
            gap: 8,
            justifyContent: 'center'
          },
          children: [/*#__PURE__*/_jsx(Button, {
            variant: "primary",
            icon: "plus",
            onClick: () => setServerForm({
              open: true,
              initial: null
            }),
            children: "\u6DFB\u52A0\u670D\u52A1\u5668"
          }), /*#__PURE__*/_jsx(Button, {
            icon: "terminal",
            onClick: () => navigate('/settings'),
            children: "\u51ED\u636E\u600E\u4E48\u914D\uFF1F"
          })]
        })
      })
    }) : /*#__PURE__*/_jsxs(_Fragment, {
      children: [/*#__PURE__*/_jsx("div", {
        className: "server-list",
        children: filtered.map(server => /*#__PURE__*/_jsx(ServerRow, {
          server: server,
          selected: server.id === selectedId,
          busy: actions.busy,
          onSelect: setSelectedId,
          onSshProbe: actions.sshProbe,
          onTcpProbe: actions.tcpProbe,
          onEditServer: target => setServerForm({
            open: true,
            initial: target
          }),
          onDeleteServer: setPendingDelete
        }, server.id))
      }), selected ? /*#__PURE__*/_jsx("div", {
        className: "card",
        style: {
          marginTop: 12
        },
        children: /*#__PURE__*/_jsx(ServerDetail, {
          server: selected,
          tab: tab,
          onTab: setTab,
          busy: actions.busy,
          onSshProbe: actions.sshProbe,
          onProbeApp: actions.probeApp,
          onAddApp: target => setAppForm({
            open: true,
            server: target,
            initial: null
          }),
          onEditApp: (target, app) => setAppForm({
            open: true,
            server: target,
            initial: app
          }),
          onDeleteApp: (target, app) => setPendingAppDelete({
            server: target,
            app
          }),
          onEditServer: target => setServerForm({
            open: true,
            initial: target
          }),
          onRegisterPort: (target, preset) => setAppForm({
            open: true,
            server: target,
            initial: {
              ...preset
            }
          })
        })
      }) : null, /*#__PURE__*/_jsx("div", {
        className: "footnote",
        style: {
          marginTop: 10
        },
        children: "SSH \u53EA\u8BFB\u91C7\u96C6\uFF1A\u4E00\u53F0\u670D\u52A1\u5668\u4E00\u6761\u56FA\u5B9A\u811A\u672C\u8BFB\u53D6\u7CFB\u7EDF\u6307\u6807\u4E0E\u771F\u5B9E\u76D1\u542C\u7AEF\u53E3\uFF08ss -lntup\uFF09\uFF0C\u65E5\u5FD7\u53EA\u8BFB\u914D\u7F6E\u91CC\u767B\u8BB0\u7684\u8DEF\u5F84\uFF1B\u5BC6\u7801\u8D70\u73AF\u5883\u53D8\u91CF\uFF0C\u79C1\u94A5\u53EA\u5B58\u8DEF\u5F84\u3002"
      })]
    }), /*#__PURE__*/_jsx(ServerFormModal, {
      open: serverForm.open,
      initial: serverForm.initial,
      submitting: submitting,
      onClose: () => setServerForm({
        open: false,
        initial: null
      }),
      onSubmit: handleServerSubmit
    }), /*#__PURE__*/_jsx(AppFormModal, {
      open: appForm.open,
      initial: appForm.initial,
      serverName: appForm.server?.name,
      submitting: submitting,
      onClose: () => setAppForm({
        open: false,
        server: null,
        initial: null
      }),
      onSubmit: handleAppSubmit
    }), /*#__PURE__*/_jsx(ConfirmDialog, {
      open: Boolean(pendingDelete),
      title: `删除服务器「${pendingDelete?.name || ''}」`,
      message: "\u4F1A\u540C\u65F6\u5220\u9664\u8FD9\u53F0\u670D\u52A1\u5668\u4E0B\u7684\u6240\u6709 APP \u8BB0\u5F55\u4E0E\u76D1\u63A7\u6570\u636E\uFF0C\u4E0D\u5F71\u54CD\u670D\u52A1\u5668\u672C\u8EAB\u3002",
      loading: deleting,
      onClose: () => setPendingDelete(null),
      onConfirm: handleDeleteServer
    }), /*#__PURE__*/_jsx(ConfirmDialog, {
      open: Boolean(pendingAppDelete),
      title: `删除应用「${pendingAppDelete?.app?.name || ''}」`,
      message: `将从「${pendingAppDelete?.server?.name || ''}」的资产记录中移除这条 APP。`,
      loading: deleting,
      onClose: () => setPendingAppDelete(null),
      onConfirm: handleDeleteApp
    })]
  });
}