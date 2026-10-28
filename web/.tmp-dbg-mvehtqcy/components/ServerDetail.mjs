import { Icon } from './Icons.mjs';
import { Button, StatusDot } from './ui.mjs';
import { DockerPanel } from './DockerPanel.mjs';
import { PortAuditTable } from './PortAuditTable.mjs';
import { ServerLogViewer } from './ServerLogViewer.mjs';
import { ServerResources } from './ServerResources.mjs';
import { ResourceTrend } from './ResourceTrend.mjs';
import { ServerApps } from './ServerApps.mjs';
import { ServerTimeline } from './EventTimeline.mjs';
import { SERVER_TABS, monitorMeta, sshTarget } from './serverShared.js';
import { timeAgo } from '../utils/format.js';

/** 服务器详情：概览 / 应用 / Docker / 端口 / 日志 / 时间线 */
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
export function ServerDetail({
  server,
  tab = 'overview',
  onTab,
  busy = {},
  onSshProbe,
  onProbeApp,
  onAddApp,
  onEditApp,
  onDeleteApp,
  onEditServer,
  onRegisterPort
}) {
  const meta = monitorMeta(server);
  const apps = server.apps || [];
  const audit = server.portAudit?.summary;
  const probing = Boolean(busy[`ssh:${server.id}`]);
  const counts = {
    apps: apps.length || null,
    docker: server.dockerSummary?.running || null,
    ports: audit?.listeningNotRecorded || null
  };
  return /*#__PURE__*/_jsxs("div", {
    className: "server-detail",
    children: [/*#__PURE__*/_jsxs("header", {
      className: "server-detail__head",
      children: [/*#__PURE__*/_jsx(StatusDot, {
        status: meta.status
      }), /*#__PURE__*/_jsx("span", {
        className: "server-detail__name",
        children: server.name
      }), /*#__PURE__*/_jsx("span", {
        className: "tech server-detail__opt",
        children: sshTarget(server)
      }), /*#__PURE__*/_jsx("span", {
        className: `status-word server-detail__opt ${meta.status === 'conflict' ? 'is-error' : ''}`,
        children: meta.text
      }), /*#__PURE__*/_jsxs("span", {
        className: "footnote server-detail__opt",
        children: ["\u91C7\u96C6 ", server.monitor?.at ? timeAgo(server.monitor.at) : '未进行']
      }), /*#__PURE__*/_jsx("span", {
        className: "spacer server-detail__spacer"
      }), /*#__PURE__*/_jsx(Button, {
        size: "sm",
        icon: "wifi",
        loading: probing,
        onClick: () => onSshProbe?.(server),
        children: "SSH \u68C0\u6D4B"
      }), /*#__PURE__*/_jsx("button", {
        type: "button",
        className: "icon-button icon-button--sm",
        title: "\u7F16\u8F91\u670D\u52A1\u5668",
        onClick: () => onEditServer?.(server),
        children: /*#__PURE__*/_jsx(Icon, {
          name: "edit",
          size: 13
        })
      })]
    }), /*#__PURE__*/_jsx("nav", {
      className: "server-tabs",
      children: SERVER_TABS.map(item => /*#__PURE__*/_jsxs("button", {
        type: "button",
        className: `server-tab ${tab === item.value ? 'is-active' : ''}`,
        onClick: () => onTab?.(item.value),
        children: [item.label, counts[item.value] ? /*#__PURE__*/_jsx("span", {
          className: `server-tab__count ${item.value === 'ports' ? 'server-tab__count--warn' : ''}`,
          children: counts[item.value]
        }) : null, item.value === 'docker' && server.dockerSummary?.unhealthy ? /*#__PURE__*/_jsx("span", {
          className: "server-tab__count server-tab__count--warn",
          children: server.dockerSummary.unhealthy
        }) : null]
      }, item.value))
    }), /*#__PURE__*/_jsxs("div", {
      className: "server-tab-body",
      children: [tab === 'overview' ? /*#__PURE__*/_jsxs(_Fragment, {
        children: [/*#__PURE__*/_jsx(ServerResources, {
          server: server,
          probing: probing,
          onProbe: onSshProbe
        }), /*#__PURE__*/_jsx(ResourceTrend, {
          server: server
        })]
      }) : null, tab === 'apps' ? /*#__PURE__*/_jsx(ServerApps, {
        server: server,
        busy: busy,
        onAddApp: onAddApp,
        onProbeApp: onProbeApp,
        onEditApp: onEditApp,
        onDeleteApp: onDeleteApp
      }) : null, tab === 'docker' ? /*#__PURE__*/_jsx(DockerPanel, {
        server: server,
        probing: probing,
        onProbe: onSshProbe,
        onRegisterPort: onRegisterPort
      }) : null, tab === 'ports' ? /*#__PURE__*/_jsx(PortAuditTable, {
        server: server,
        audit: server.portAudit,
        busy: busy,
        loading: probing,
        onProbeApp: onProbeApp,
        onEditApp: onEditApp,
        onRegisterPort: onRegisterPort,
        onRefresh: onSshProbe
      }) : null, tab === 'logs' ? /*#__PURE__*/_jsx(ServerLogViewer, {
        server: server,
        onEditServer: onEditServer
      }) : null, tab === 'timeline' ? /*#__PURE__*/_jsx(ServerTimeline, {
        serverId: server.id
      }) : null]
    })]
  });
}