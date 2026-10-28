import { Icon } from './Icons.mjs';
import { Button } from './ui.mjs';
import { formatBytes, formatPercent, usageTone } from '../utils/format.js';

/**
 * 项目资源占用面板（第七阶段）。
 *
 * 只展示**已经采集到**的数据，不做任何估算：
 *   - 合计 = 能归因到本项目的**容器** CPU / 内存（自动关联依据只有端口，或用户手工登记的关联）；
 *   - 整机 CPU / 内存 / 磁盘单列为「参照」，明确标注不计入合计；
 *   - 没有关联到容器时显示"暂无归集到的容器资源"，而不是编一个数字。
 */
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function ProjectResources({
  resources,
  onLinkServer = null,
  onUnlink = null
}) {
  if (!resources) return null;
  const {
    totals,
    servers = [],
    containers = [],
    unlinkedServers = []
  } = resources;
  return /*#__PURE__*/_jsxs("div", {
    className: "res-panel",
    children: [/*#__PURE__*/_jsxs("div", {
      className: "res-panel__head",
      children: [/*#__PURE__*/_jsxs("span", {
        className: "res-panel__title",
        children: [/*#__PURE__*/_jsx(Icon, {
          name: "activity",
          size: 14,
          style: {
            color: '#7dd3fc'
          }
        }), "\u8D44\u6E90\u5360\u7528"]
      }), totals.hasData ? /*#__PURE__*/_jsxs("span", {
        className: "row",
        style: {
          gap: 12
        },
        children: [/*#__PURE__*/_jsxs("span", {
          className: "tech",
          children: ["CPU ", /*#__PURE__*/_jsx("b", {
            style: {
              color: usageTone(totals.cpuPercent)
            },
            children: formatPercent(totals.cpuPercent, 1)
          })]
        }), /*#__PURE__*/_jsxs("span", {
          className: "tech",
          children: ["\u5185\u5B58 ", /*#__PURE__*/_jsx("b", {
            children: formatBytes(totals.memoryUsedBytes)
          })]
        }), /*#__PURE__*/_jsxs("span", {
          className: "tech",
          children: ["\u5BB9\u5668 ", /*#__PURE__*/_jsx("b", {
            children: totals.runningContainerCount
          })]
        })]
      }) : /*#__PURE__*/_jsx("span", {
        className: "status-word muted",
        children: "\u6682\u65E0\u5F52\u96C6\u5230\u7684\u5BB9\u5668\u8D44\u6E90"
      })]
    }), /*#__PURE__*/_jsxs("div", {
      className: "footnote",
      style: {
        marginBottom: 6
      },
      children: ["\u5408\u8BA1\u53EA\u7EDF\u8BA1\u80FD\u5F52\u56E0\u5230\u672C\u9879\u76EE\u7684\u5BB9\u5668\uFF1B\u6574\u673A\u6307\u6807\u4E0D\u8BA1\u5165\uFF08", totals.note, "\uFF09"]
    }), containers.length > 0 ? /*#__PURE__*/_jsx("div", {
      className: "res-table",
      children: containers.map(container => /*#__PURE__*/_jsxs("div", {
        className: "res-table__row",
        children: [/*#__PURE__*/_jsx("span", {
          className: "res-name",
          title: container.image || container.name,
          children: container.name
        }), /*#__PURE__*/_jsx("span", {
          className: "tech muted",
          children: container.serverName
        }), /*#__PURE__*/_jsx("span", {
          className: `status-word ${container.auto ? 'muted' : 'is-warn'}`,
          children: container.basis
        }), /*#__PURE__*/_jsx("span", {
          className: "tech",
          style: {
            color: usageTone(container.cpuPercent),
            textAlign: 'right'
          },
          children: container.cpuPercent === null || container.cpuPercent === undefined ? '—' : formatPercent(container.cpuPercent, 1)
        }), /*#__PURE__*/_jsx("span", {
          className: "tech",
          style: {
            textAlign: 'right'
          },
          children: container.memoryUsedBytes ? formatBytes(container.memoryUsedBytes) : '—'
        })]
      }, `${container.serverId}/${container.name}`))
    }) : null, servers.filter(item => item.system).length > 0 ? /*#__PURE__*/_jsxs("div", {
      className: "res-system",
      children: [/*#__PURE__*/_jsx("div", {
        className: "footnote",
        style: {
          marginBottom: 4
        },
        children: "\u6574\u673A\u6307\u6807\uFF08\u4EC5\u4F5C\u53C2\u7167\uFF0C\u4E0D\u8BA1\u5165\u4E0A\u65B9\u5408\u8BA1\uFF09"
      }), servers.filter(item => item.system).map(server => /*#__PURE__*/_jsxs("div", {
        className: "res-system__row",
        children: [/*#__PURE__*/_jsxs("span", {
          className: "row",
          style: {
            gap: 6
          },
          children: [/*#__PURE__*/_jsx(Icon, {
            name: "server",
            size: 12
          }), /*#__PURE__*/_jsx("span", {
            className: "res-name",
            children: server.serverName
          }), !server.online ? /*#__PURE__*/_jsx("span", {
            className: "status-word is-error",
            children: "\u79BB\u7EBF"
          }) : null]
        }), /*#__PURE__*/_jsxs("span", {
          className: "footnote",
          children: ["CPU ", server.system.cpuUsagePercent === null || server.system.cpuUsagePercent === undefined ? '—' : formatPercent(server.system.cpuUsagePercent, 1), " \xB7 \u5185\u5B58", ' ', server.system.memoryUsedPercent === null || server.system.memoryUsedPercent === undefined ? '—' : formatPercent(server.system.memoryUsedPercent, 1), "\uFF08", formatBytes(server.system.memoryUsedBytes), " / ", formatBytes(server.system.memoryTotalBytes), "\uFF09"]
        })]
      }, server.serverId))]
    }) : null, unlinkedServers.length > 0 ? /*#__PURE__*/_jsxs("div", {
      className: "row row--wrap",
      style: {
        gap: 8,
        marginTop: 8
      },
      children: [/*#__PURE__*/_jsx("span", {
        className: "footnote",
        children: "\u672A\u5173\u8054\uFF1A"
      }), unlinkedServers.map(item => /*#__PURE__*/_jsx("span", {
        className: "tech",
        title: item.reason,
        children: item.serverName
      }, item.serverId)), onLinkServer ? /*#__PURE__*/_jsx(Button, {
        size: "sm",
        icon: "link",
        onClick: onLinkServer,
        children: "\u767B\u8BB0\u5173\u8054"
      }) : null]
    }) : null, onUnlink ? /*#__PURE__*/_jsx("div", {
      className: "row",
      style: {
        gap: 8,
        marginTop: 6
      },
      children: /*#__PURE__*/_jsx(Button, {
        size: "sm",
        icon: "x",
        onClick: onUnlink,
        children: "\u53D6\u6D88\u624B\u5DE5\u5173\u8054"
      })
    }) : null]
  });
}