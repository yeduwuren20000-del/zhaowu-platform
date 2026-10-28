import { Icon } from './Icons.mjs';
import { Button, Menu, StatusDot } from './ui.mjs';
import { formatLatency, formatPercent, usageTone } from '../utils/format.js';
import { monitorMeta, sshTarget } from './serverShared.js';

/**
 * 服务器列表行：一眼看清「在不在 / 资源多少 / 有没有异常」，点开看细节。
 *
 * 与项目行同一套约定：
 *   - 主操作（SSH 检测）常驻，其余收进「⋯」；
 *   - 异常（未登记端口 / 记录未监听 / 容器异常）才上色，正常项保持灰。
 */
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function ServerRow({
  server,
  selected,
  busy = {},
  onSelect,
  onSshProbe,
  onTcpProbe,
  onEditServer,
  onDeleteServer
}) {
  const meta = monitorMeta(server);
  const apps = server.apps || [];
  const unrecorded = server.portAudit?.summary?.listeningNotRecorded || 0;
  const notListening = server.portAudit?.summary?.recordedNotListening || 0;
  const unhealthy = server.dockerSummary?.unhealthy || 0;
  const cpu = server.resources?.cpuUsagePercent;
  const mem = server.resources?.memory?.usedPercent;
  const containers = server.dockerSummary?.running;
  return /*#__PURE__*/_jsxs("div", {
    className: `server-row ${selected ? 'is-selected' : ''}`,
    "data-server-id": server.id,
    role: "button",
    tabIndex: 0,
    onClick: () => onSelect?.(server.id),
    onKeyDown: event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onSelect?.(server.id);
      }
    },
    children: [/*#__PURE__*/_jsx(StatusDot, {
      status: meta.status
    }), /*#__PURE__*/_jsx("span", {
      className: "server-row__name",
      children: server.name
    }), /*#__PURE__*/_jsx("span", {
      className: `status-word ${meta.status === 'conflict' ? 'is-error' : ''}`,
      children: meta.text
    }), /*#__PURE__*/_jsxs("span", {
      className: "server-row__resources",
      children: [/*#__PURE__*/_jsxs("span", {
        className: "srv-res",
        title: "CPU \u4F7F\u7528\u7387\uFF08\u6574\u673A\uFF09",
        children: ["CPU ", /*#__PURE__*/_jsx("b", {
          style: {
            color: usageTone(cpu)
          },
          children: formatPercent(cpu)
        })]
      }), /*#__PURE__*/_jsxs("span", {
        className: "srv-res",
        title: "\u5185\u5B58\u4F7F\u7528\u7387\uFF08\u6574\u673A\uFF09",
        children: ["\u5185\u5B58 ", /*#__PURE__*/_jsx("b", {
          style: {
            color: usageTone(mem)
          },
          children: formatPercent(mem)
        })]
      }), containers ? /*#__PURE__*/_jsxs("span", {
        className: "srv-res",
        title: "\u8FD0\u884C\u4E2D\u7684\u5BB9\u5668",
        children: ["\u5BB9\u5668 ", /*#__PURE__*/_jsx("b", {
          children: containers
        })]
      }) : null]
    }), /*#__PURE__*/_jsx("span", {
      className: "tech",
      children: sshTarget(server)
    }), /*#__PURE__*/_jsx("span", {
      className: "tech muted",
      title: server.os,
      children: server.os || '—'
    }), /*#__PURE__*/_jsxs("span", {
      className: "server-row__facts",
      children: [/*#__PURE__*/_jsxs("span", {
        children: ["\u5EF6\u8FDF ", /*#__PURE__*/_jsx("b", {
          children: formatLatency(server.monitor?.latencyMs)
        })]
      }), /*#__PURE__*/_jsxs("span", {
        children: ["\u5E94\u7528 ", /*#__PURE__*/_jsx("b", {
          children: apps.length
        })]
      }), unrecorded > 0 ? /*#__PURE__*/_jsxs("span", {
        className: "status-word is-error",
        children: ["\u672A\u767B\u8BB0\u7AEF\u53E3 ", unrecorded]
      }) : null, notListening > 0 ? /*#__PURE__*/_jsxs("span", {
        className: "status-word is-warn",
        children: ["\u8BB0\u5F55\u672A\u76D1\u542C ", notListening]
      }) : null, unhealthy > 0 ? /*#__PURE__*/_jsxs("span", {
        className: "status-word is-error",
        children: ["\u5BB9\u5668\u5F02\u5E38 ", unhealthy]
      }) : null, server.monitorEnabled === false ? /*#__PURE__*/_jsx("span", {
        className: "status-word muted",
        children: "\u76D1\u63A7\u5DF2\u5173\u95ED"
      }) : null]
    }), /*#__PURE__*/_jsxs("div", {
      className: "server-row__actions",
      onClick: event => event.stopPropagation(),
      children: [/*#__PURE__*/_jsx(Button, {
        size: "sm",
        variant: meta.status === 'running' ? undefined : 'primary',
        icon: "wifi",
        loading: busy[`ssh:${server.id}`],
        onClick: () => onSshProbe?.(server),
        children: "SSH \u68C0\u6D4B"
      }), /*#__PURE__*/_jsx(Menu, {
        align: "right",
        width: 186,
        label: `${server.name} 的更多操作`,
        trigger: ({
          toggle,
          ariaLabel
        }) => /*#__PURE__*/_jsx("button", {
          type: "button",
          className: "icon-button",
          onClick: toggle,
          title: ariaLabel,
          "aria-label": ariaLabel,
          children: /*#__PURE__*/_jsx(Icon, {
            name: "more",
            size: 14
          })
        }),
        items: [{
          key: 'tcp',
          label: 'TCP 连通性探测',
          icon: 'activity',
          hint: '只测端口通不通，不登录',
          onClick: () => onTcpProbe?.(server)
        }, {
          key: 'edit',
          label: '编辑服务器',
          icon: 'edit',
          onClick: () => onEditServer?.(server)
        }, {
          key: 'delete',
          label: '删除服务器',
          icon: 'trash',
          danger: true,
          onClick: () => onDeleteServer?.(server)
        }]
      })]
    })]
  });
}