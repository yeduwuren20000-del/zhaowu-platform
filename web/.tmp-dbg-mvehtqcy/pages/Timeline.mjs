import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { useToast } from '../hooks/useToast.mjs';
import { EventTimeline } from '../components/EventTimeline.mjs';
import { PageHint } from '../components/PageHint.mjs';
import { Button, Card, ConfirmDialog, EmptyState, ErrorNotice, SearchBox, SkeletonList, Tabs } from '../components/ui.mjs';

/**
 * 第六阶段：服务生命周期时间线页。
 * 事件只在"状态真的变化"时产生（启动 / 停止 / 异常退出 / 恢复 / 端口冲突或变化 / 发现新服务 / SSH 与 Docker 变化），
 * 因此这里看到的是变化历史，不是每秒快照。可按项目、服务器与事件类型筛选。
 */
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function TimelinePage() {
  const location = useLocation();
  const toast = useToast();
  const [projectId, setProjectId] = useState(location.state?.projectId || '');
  const [serverId, setServerId] = useState('');
  const [type, setType] = useState('all');
  const [query, setQuery] = useState('');
  const [pendingClear, setPendingClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const {
    data: projects
  } = useAsync(() => api.projects(), {
    deps: []
  });
  const {
    data: servers
  } = useAsync(() => api.servers(), {
    deps: []
  });
  const {
    data,
    loading,
    error,
    reload
  } = useAsync(() => api.events({
    projectId: projectId || null,
    serverId: serverId || null,
    type: type === 'all' ? null : type,
    limit: 300
  }), {
    deps: [projectId, serverId, type]
  });
  useEffect(() => {
    if (location.state?.projectId) setProjectId(location.state.projectId);
  }, [location.state]);
  const items = useMemo(() => {
    const list = data?.items || [];
    const text = query.trim().toLowerCase();
    if (!text) return list;
    return list.filter(event => [event.message, event.detail, event.projectName, event.serverName, event.serviceName, event.processName, event.port].filter(value => value !== null && value !== undefined).some(value => String(value).toLowerCase().includes(text)));
  }, [data, query]);

  // 降噪：默认只显示「有事件」的类型标签，0 条的不占位置；
  // 但如果用户正选中某个 0 条的类型，仍然保留它，否则会失去切回「全部」的退路。
  const typeOptions = useMemo(() => {
    const all = {
      value: 'all',
      label: '全部',
      count: data?.total ?? 0
    };
    const list = (data?.typeOptions || []).map(item => ({
      value: item.value,
      label: item.label,
      count: item.count
    }));
    const visible = list.filter(item => item.count > 0 || item.value === type);
    return [all, ...visible];
  }, [data, type]);
  async function handleClear() {
    setClearing(true);
    try {
      const result = await api.clearEvents();
      toast.success('时间线已清空', `移除 ${result?.removed ?? 0} 条事件（当前状态指纹保留，不会重放成"刚刚变化"）`);
      setPendingClear(false);
      await reload();
    } catch (err) {
      toast.error('清空失败', err.message);
    } finally {
      setClearing(false);
    }
  }
  return /*#__PURE__*/_jsxs("div", {
    className: "page",
    children: [/*#__PURE__*/_jsxs("div", {
      className: "page__header",
      children: [/*#__PURE__*/_jsx("div", {
        className: "page__title",
        children: "\u65F6\u95F4\u7EBF"
      }), /*#__PURE__*/_jsxs("div", {
        className: "page__actions",
        children: [/*#__PURE__*/_jsx(Button, {
          icon: "refresh",
          loading: loading,
          onClick: () => reload().catch(() => {}),
          children: "\u5237\u65B0"
        }), /*#__PURE__*/_jsx(Button, {
          variant: "danger",
          icon: "trash",
          onClick: () => setPendingClear(true),
          children: "\u6E05\u7A7A\u65F6\u95F4\u7EBF"
        })]
      })]
    }), /*#__PURE__*/_jsx(PageHint, {
      id: "timeline",
      icon: "clock",
      children: "\u542F\u52A8\u3001\u505C\u6B62\u3001\u62A5\u9519\u3001\u7AEF\u53E3\u53D8\u5316\u90FD\u4F1A\u8BB0\u5728\u8FD9\u3002\u60F3\u4E0D\u8D77\u300C\u521A\u624D\u52A8\u8FC7\u4EC0\u4E48\u300D\u65F6\uFF0C\u6309\u9879\u76EE\u6216\u7C7B\u578B\u5F80\u56DE\u7FFB\u3002"
    }), /*#__PURE__*/_jsxs("div", {
      className: "card",
      children: [/*#__PURE__*/_jsxs("div", {
        className: "toolbar",
        children: [/*#__PURE__*/_jsxs("select", {
          className: "select",
          style: {
            maxWidth: 260
          },
          value: projectId,
          onChange: event => {
            setProjectId(event.target.value);
            setServerId('');
          },
          children: [/*#__PURE__*/_jsx("option", {
            value: "",
            children: "\u5168\u90E8\u9879\u76EE"
          }), (projects || []).map(project => /*#__PURE__*/_jsxs("option", {
            value: project.id,
            children: [project.name, "\uFF08", project.port ?? '未记录端口', "\uFF09"]
          }, project.id))]
        }), /*#__PURE__*/_jsxs("select", {
          className: "select",
          style: {
            maxWidth: 220
          },
          value: serverId,
          onChange: event => {
            setServerId(event.target.value);
            setProjectId('');
          },
          children: [/*#__PURE__*/_jsx("option", {
            value: "",
            children: "\u5168\u90E8\u670D\u52A1\u5668"
          }), (servers || []).map(server => /*#__PURE__*/_jsx("option", {
            value: server.id,
            children: server.name
          }, server.id))]
        }), /*#__PURE__*/_jsx(SearchBox, {
          value: query,
          onChange: setQuery,
          placeholder: "\u6309\u6D88\u606F / \u8FDB\u7A0B / \u7AEF\u53E3\u7B5B\u9009\u2026",
          width: 240
        }), /*#__PURE__*/_jsx("div", {
          className: "spacer"
        }), /*#__PURE__*/_jsxs("span", {
          className: "footnote",
          children: ["\u5171 ", data?.total ?? 0, " \u6761 \xB7 \u672C\u6B21\u8FD4\u56DE ", items.length, " \u6761"]
        })]
      }), /*#__PURE__*/_jsx(Tabs, {
        value: type,
        onChange: setType,
        options: typeOptions
      })]
    }), error ? /*#__PURE__*/_jsx(ErrorNotice, {
      error: error,
      onRetry: () => reload().catch(() => {})
    }) : null, /*#__PURE__*/_jsx(Card, {
      flush: true,
      children: /*#__PURE__*/_jsx("div", {
        style: {
          padding: 12
        },
        children: loading && !data ? /*#__PURE__*/_jsx(SkeletonList, {
          rows: 5
        }) : items.length === 0 ? /*#__PURE__*/_jsx(EmptyState, {
          title: data?.total ? '没有匹配的事件' : '还没有事件',
          hint: data?.total ? '换个筛选条件试试。' : '启动或停止一个项目、做一次 SSH 检测，这里就会记录变化。'
        }) : /*#__PURE__*/_jsx(EventTimeline, {
          events: items
        })
      })
    }), /*#__PURE__*/_jsx(ConfirmDialog, {
      open: pendingClear,
      title: "\u6E05\u7A7A\u4E8B\u4EF6\u65F6\u95F4\u7EBF",
      message: "\u53EA\u4F1A\u5220\u9664\u5DF2\u8BB0\u5F55\u7684\u4E8B\u4EF6\u5217\u8868\uFF0C\u5404\u9879\u76EE\u7684\u5F53\u524D\u72B6\u6001\u6307\u7EB9\u4F1A\u4FDD\u7559\uFF0C\u56E0\u6B64\u6E05\u7A7A\u540E\u4E0D\u4F1A\u628A\u73B0\u6709\u670D\u52A1\u91CD\u653E\u6210\u300C\u521A\u521A\u542F\u52A8\u300D\u3002",
      confirmText: "\u786E\u8BA4\u6E05\u7A7A",
      loading: clearing,
      onClose: () => setPendingClear(false),
      onConfirm: handleClear
    })]
  });
}