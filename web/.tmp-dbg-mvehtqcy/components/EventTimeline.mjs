import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { EmptyState, ErrorNotice, Loading } from './ui.mjs';
import { eventDotColor, eventMeta, formatClock, formatDateTime } from '../utils/format.js';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
const SOURCE_TEXT = {
  action: '手动'
};

/** 事实字段：端口 / PID / 进程 / 地址；消息里已经写过的数字不再重复一遍 */
function EventFacts({
  event
}) {
  const message = event.message || '';
  const facts = [];
  const add = (text, probe) => {
    if (text && !message.includes(probe ?? text)) facts.push(text);
  };
  add(event.serviceName);
  if (event.port) add(`:${event.port}`, String(event.port));
  add(event.processName);
  if (event.pid) add(`PID ${event.pid}`, String(event.pid));
  add(event.address);
  add(event.code);
  if (!facts.length) return null;
  return /*#__PURE__*/_jsx("div", {
    className: "timeline__facts",
    children: facts.map(text => /*#__PURE__*/_jsx("span", {
      children: text
    }, text))
  });
}
function TimelineRow({
  event
}) {
  const meta = eventMeta(event.type);
  const tone = event.level === 'error' ? 'is-error' : event.level === 'warn' ? 'is-warn' : '';
  return /*#__PURE__*/_jsxs("div", {
    className: "timeline__item",
    children: [/*#__PURE__*/_jsx("span", {
      className: "timeline__time",
      title: formatDateTime(event.at),
      children: formatClock(event.at)
    }), /*#__PURE__*/_jsx("span", {
      className: "timeline__dot",
      style: {
        background: eventDotColor(event.level)
      }
    }), /*#__PURE__*/_jsxs("div", {
      className: "timeline__main",
      children: [/*#__PURE__*/_jsxs("div", {
        className: "timeline__head",
        children: [/*#__PURE__*/_jsx("span", {
          className: `status-word ${tone}`,
          children: meta.text
        }), /*#__PURE__*/_jsx("span", {
          className: "timeline__msg",
          children: event.message
        }), SOURCE_TEXT[event.source] ? /*#__PURE__*/_jsx("span", {
          className: "timeline__tag",
          children: SOURCE_TEXT[event.source]
        }) : null]
      }), event.detail ? /*#__PURE__*/_jsx("div", {
        className: "timeline__detail",
        children: event.detail
      }) : null, /*#__PURE__*/_jsx(EventFacts, {
        event: event
      })]
    })]
  });
}

/** 事件流：时间 / 状态点 / 内容三列对齐，同一主体的连续事件归为一组 */
export function EventTimeline({
  events = [],
  maxHeight,
  showSubject = true,
  emptyText = '暂无事件'
}) {
  const navigate = useNavigate();
  if (events.length === 0) return /*#__PURE__*/_jsx(EmptyState, {
    title: emptyText
  });
  const groups = [];
  events.forEach((event, index) => {
    const subject = event.projectName || event.serverName || event.serviceName || '系统';
    const last = groups[groups.length - 1];
    if (last && last.subject === subject) {
      last.items.push(event);
    } else {
      groups.push({
        subject,
        key: `${subject}-${index}`,
        projectId: event.projectId || null,
        serverId: event.serverId || null,
        items: [event]
      });
    }
  });
  return /*#__PURE__*/_jsx("div", {
    className: "timeline",
    style: maxHeight ? {
      maxHeight,
      overflowY: 'auto'
    } : undefined,
    children: groups.map(group => {
      const jump = () => {
        if (group.projectId) navigate('/projects', {
          state: {
            focus: group.projectId
          }
        });else if (group.serverId) navigate('/servers', {
          state: {
            focus: group.serverId
          }
        });
      };
      return /*#__PURE__*/_jsxs("div", {
        className: "timeline__group",
        children: [showSubject && group.subject !== '系统' ? /*#__PURE__*/_jsxs("div", {
          className: "timeline__group-head",
          children: [group.projectId || group.serverId ? /*#__PURE__*/_jsx("button", {
            type: "button",
            className: "timeline__group-name link",
            onClick: jump,
            children: group.subject
          }) : /*#__PURE__*/_jsx("span", {
            className: "timeline__group-name",
            children: group.subject
          }), /*#__PURE__*/_jsx("span", {
            className: "timeline__group-count",
            children: group.items.length
          })]
        }) : null, group.items.map((event, index) => /*#__PURE__*/_jsx(TimelineRow, {
          event: event
        }, event.id || `${event.at}-${index}`))]
      }, group.key);
    })
  });
}

/** 项目详情里的时间线：只取这个项目的事件 */
export function ProjectTimeline({
  projectId,
  limit = 20
}) {
  const {
    data,
    loading,
    error,
    reload
  } = useAsync(() => api.events({
    projectId,
    limit
  }), {
    deps: [projectId, limit]
  });
  const navigate = useNavigate();
  if (loading && !data) return /*#__PURE__*/_jsx(Loading, {
    text: "\u8BFB\u53D6\u4E8B\u4EF6\u2026"
  });
  if (error) return /*#__PURE__*/_jsx(ErrorNotice, {
    error: error,
    onRetry: () => reload().catch(() => {})
  });
  const items = data.items || [];
  return /*#__PURE__*/_jsxs("div", {
    className: "project-timeline",
    children: [/*#__PURE__*/_jsxs("div", {
      className: "row",
      style: {
        justifyContent: 'space-between',
        marginBottom: 6
      },
      children: [/*#__PURE__*/_jsxs("span", {
        className: "footnote",
        children: ["\u751F\u547D\u5468\u671F\u4E8B\u4EF6 ", items.length]
      }), /*#__PURE__*/_jsx("button", {
        type: "button",
        className: "link",
        onClick: () => navigate('/timeline', {
          state: {
            projectId
          }
        }),
        children: "\u67E5\u770B\u5B8C\u6574\u65F6\u95F4\u7EBF"
      })]
    }), /*#__PURE__*/_jsx(EventTimeline, {
      events: items,
      maxHeight: 280,
      showSubject: false,
      emptyText: "\u8FD9\u4E2A\u9879\u76EE\u8FD8\u6CA1\u6709\u72B6\u6001\u53D8\u5316\u3002"
    })]
  });
}

/** 服务器详情的时间线标签：只取这台服务器的事件 */
export function ServerTimeline({
  serverId,
  limit = 60
}) {
  const {
    data,
    loading,
    error,
    reload
  } = useAsync(() => api.events({
    serverId,
    limit
  }), {
    deps: [serverId, limit]
  });
  if (loading && !data) return /*#__PURE__*/_jsx(Loading, {
    text: "\u8BFB\u53D6\u4E8B\u4EF6\u2026"
  });
  if (error) return /*#__PURE__*/_jsx(ErrorNotice, {
    error: error,
    onRetry: () => reload().catch(() => {})
  });
  return /*#__PURE__*/_jsx(EventTimeline, {
    events: data.items || [],
    showSubject: false,
    emptyText: "\u8FD9\u53F0\u670D\u52A1\u5668\u8FD8\u6CA1\u6709\u72B6\u6001\u53D8\u5316\u3002"
  });
}