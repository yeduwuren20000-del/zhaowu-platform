import { Button, EmptyState, StatusDot } from './ui.mjs';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
const APP_STATUS = {
  running: '运行中',
  stopped: '已停止',
  unknown: '未知'
};

/** 应用与部署路径：端口 / 名称 / 路径 / 状态，操作在 hover 时出现 */
export function ServerApps({
  server,
  busy = {},
  onAddApp,
  onProbeApp,
  onEditApp,
  onDeleteApp
}) {
  const apps = server.apps || [];
  if (!apps.length) {
    return /*#__PURE__*/_jsx(EmptyState, {
      title: "\u6CA1\u6709\u5E94\u7528\u8BB0\u5F55",
      action: /*#__PURE__*/_jsx(Button, {
        variant: "primary",
        icon: "plus",
        onClick: () => onAddApp?.(server),
        children: "\u65B0\u589E APP"
      })
    });
  }
  return /*#__PURE__*/_jsx("div", {
    style: {
      overflowX: 'auto'
    },
    children: /*#__PURE__*/_jsxs("table", {
      className: "table",
      children: [/*#__PURE__*/_jsx("thead", {
        children: /*#__PURE__*/_jsxs("tr", {
          children: [/*#__PURE__*/_jsx("th", {
            style: {
              width: 72
            },
            children: "\u7AEF\u53E3"
          }), /*#__PURE__*/_jsx("th", {
            children: "\u5E94\u7528 / \u670D\u52A1"
          }), /*#__PURE__*/_jsx("th", {
            children: "\u90E8\u7F72\u8DEF\u5F84"
          }), /*#__PURE__*/_jsx("th", {
            style: {
              width: 96
            },
            children: "\u72B6\u6001"
          }), /*#__PURE__*/_jsx("th", {
            style: {
              width: 190,
              textAlign: 'right'
            },
            children: "\u64CD\u4F5C"
          })]
        })
      }), /*#__PURE__*/_jsx("tbody", {
        children: apps.map(app => /*#__PURE__*/_jsxs("tr", {
          children: [/*#__PURE__*/_jsx("td", {
            className: "table__port",
            children: app.port ?? '—'
          }), /*#__PURE__*/_jsxs("td", {
            children: [app.name, app.url ? /*#__PURE__*/_jsx("div", {
              className: "tech muted",
              children: app.url
            }) : null]
          }), /*#__PURE__*/_jsx("td", {
            children: /*#__PURE__*/_jsx("span", {
              className: "table__path",
              title: app.deployPath,
              children: app.deployPath || '—'
            })
          }), /*#__PURE__*/_jsx("td", {
            children: /*#__PURE__*/_jsxs("span", {
              className: "row",
              style: {
                gap: 6
              },
              children: [/*#__PURE__*/_jsx(StatusDot, {
                status: app.status === 'running' ? 'running' : app.status === 'stopped' ? 'stopped' : 'unknown'
              }), /*#__PURE__*/_jsx("span", {
                className: "status-word",
                children: APP_STATUS[app.status] || 'Unknown'
              })]
            })
          }), /*#__PURE__*/_jsx("td", {
            children: /*#__PURE__*/_jsxs("div", {
              className: "table__actions",
              children: [/*#__PURE__*/_jsx(Button, {
                size: "sm",
                icon: "wifi",
                loading: busy[`app:${server.id}:${app.id}`],
                onClick: () => onProbeApp?.(server, app),
                children: "\u7AEF\u53E3\u63A2\u6D4B"
              }), /*#__PURE__*/_jsxs("span", {
                className: "row-actions",
                children: [/*#__PURE__*/_jsx(Button, {
                  size: "sm",
                  icon: "edit",
                  onClick: () => onEditApp?.(server, app),
                  children: "\u7F16\u8F91"
                }), /*#__PURE__*/_jsx(Button, {
                  size: "sm",
                  icon: "trash",
                  onClick: () => onDeleteApp?.(server, app),
                  children: "\u5220\u9664"
                })]
              })]
            })
          })]
        }, app.id))
      })]
    })
  });
}