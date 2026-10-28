import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { useToast } from '../hooks/useToast.mjs';
import { LogPanel, normalizeEvents, normalizeTextLines } from '../components/LogPanel.mjs';
import { PageHint } from '../components/PageHint.mjs';
import { Button, Card, ErrorNotice, SkeletonLines, Switch } from '../components/ui.mjs';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
const WORKBENCH = 'workbench';
export function LogsPage() {
  const location = useLocation();
  const toast = useToast();
  const {
    data: projects
  } = useAsync(() => api.projects(), {
    deps: []
  });
  const [source, setSource] = useState(WORKBENCH);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(true);
  const [error, setError] = useState(null);
  const [logFile, setLogFile] = useState('');
  useEffect(() => {
    if (location.state?.source) setSource(location.state.source);
  }, [location.state]);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (source.startsWith('project:')) {
        const result = await api.projectLog(source.slice('project:'.length), 400);
        setEntries(normalizeTextLines(result.lines));
        setLogFile(result.file);
      } else {
        const result = await api.logs(400);
        setEntries(normalizeEvents(result.events));
        setLogFile(result.file);
      }
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [source]);
  useEffect(() => {
    load();
  }, [load]);

  // 实时追踪：SSE 推送（后端每秒比对文件内容）
  useEffect(() => {
    if (!live) return undefined;
    const stream = new EventSource(api.logStreamUrl(source));
    stream.onmessage = event => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.error) return;
        if (payload.events) setEntries(normalizeEvents(payload.events));else if (payload.lines) setEntries(normalizeTextLines(payload.lines));
      } catch {
        /* 忽略心跳等非 JSON 数据 */
      }
    };
    stream.onerror = () => {
      /* 断线由浏览器自动重连 */
    };
    return () => stream.close();
  }, [live, source]);
  const options = useMemo(() => [{
    id: WORKBENCH,
    name: '工作台事件'
  }, ...(projects || []).map(project => ({
    id: `project:${project.id}`,
    name: `项目进程 · ${project.name}`
  }))], [projects]);

  // 空态按来源给指引：工作台事件靠"发生事情"产生，项目日志靠"跑起来"产生
  const isProjectLog = source.startsWith('project:');
  const logEmpty = isProjectLog ? {
    text: '这个项目还没有进程日志。',
    hint: '在「本地项目」点一次启动，它的输出会实时出现在这；起不来时，最后几行通常就是原因。'
  } : {
    text: '工作台事件日志还是空的。',
    hint: '启动 / 停止项目、做 SSH 检测、发现新服务，都会自动记到这里。'
  };
  async function clear() {
    try {
      if (source.startsWith('project:')) {
        await api.clearProjectLog(source.slice('project:'.length));
      } else {
        await api.clearLogs();
      }
      toast.success('日志已清空', source === WORKBENCH ? '工作台事件日志' : '该项目的过程日志');
      await load();
    } catch (err) {
      toast.error('清空失败', err.message);
    }
  }
  return /*#__PURE__*/_jsxs("div", {
    className: "page",
    children: [/*#__PURE__*/_jsxs("div", {
      className: "page__header",
      children: [/*#__PURE__*/_jsx("div", {
        className: "page__title",
        children: "\u65E5\u5FD7\u4E2D\u5FC3"
      }), /*#__PURE__*/_jsxs("div", {
        className: "page__actions",
        children: [/*#__PURE__*/_jsx(Switch, {
          checked: live,
          onChange: setLive,
          label: "\u5B9E\u65F6\u8FFD\u8E2A"
        }), /*#__PURE__*/_jsx(Button, {
          icon: "refresh",
          loading: loading,
          onClick: load,
          children: "\u5237\u65B0"
        }), /*#__PURE__*/_jsx(Button, {
          variant: "danger",
          icon: "trash",
          onClick: clear,
          children: "\u6E05\u7A7A"
        })]
      })]
    }), /*#__PURE__*/_jsx(PageHint, {
      id: "logs",
      icon: "terminal",
      children: "\u5DE5\u4F5C\u53F0\u4E8B\u4EF6\u548C\u6BCF\u4E2A\u9879\u76EE\u7684\u8FDB\u7A0B\u8F93\u51FA\u90FD\u96C6\u4E2D\u5728\u8FD9\u3002\u9879\u76EE\u8D77\u4E0D\u6765\u65F6\uFF0C\u5728\u4E0A\u65B9\u9009\u300C\u9879\u76EE\u8FDB\u7A0B \xB7 \u9879\u76EE\u540D\u300D\uFF0C\u770B\u5B83\u6700\u540E\u6253\u5370\u4E86\u4EC0\u4E48\u3002"
    }), /*#__PURE__*/_jsxs("div", {
      className: "toolbar",
      children: [/*#__PURE__*/_jsx("select", {
        className: "select",
        style: {
          maxWidth: 420
        },
        value: source,
        onChange: event => setSource(event.target.value),
        children: options.map(option => /*#__PURE__*/_jsx("option", {
          value: option.id,
          children: option.name
        }, option.id))
      }), /*#__PURE__*/_jsxs("span", {
        className: "footnote",
        children: ["\u5171 ", entries.length, " \u884C"]
      }), /*#__PURE__*/_jsx("span", {
        className: `status-word ${live ? '' : 'muted'}`,
        children: live ? '实时推送中' : '已暂停'
      }), /*#__PURE__*/_jsx("div", {
        className: "spacer"
      }), /*#__PURE__*/_jsx("span", {
        className: "tech muted",
        children: logFile
      })]
    }), error ? /*#__PURE__*/_jsx(ErrorNotice, {
      error: error,
      onRetry: () => load().catch(() => {})
    }) : null, /*#__PURE__*/_jsx(Card, {
      flush: true,
      children: /*#__PURE__*/_jsx("div", {
        style: {
          padding: 12
        },
        children: loading && entries.length === 0 ? /*#__PURE__*/_jsx(SkeletonLines, {
          rows: 8
        }) : /*#__PURE__*/_jsx(LogPanel, {
          entries: entries,
          height: 460,
          emptyText: logEmpty.text,
          emptyHint: logEmpty.hint
        })
      })
    })]
  });
}