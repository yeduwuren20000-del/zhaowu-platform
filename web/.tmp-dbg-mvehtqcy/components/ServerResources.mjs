import { Button, EmptyState, Fact, Meter, Notice } from './ui.mjs';
import { formatBytes, formatDateTime, formatLatency, formatLoad, formatUptime, usageTone } from '../utils/format.js';

/** 服务器资源面板：SSH 只读采集到的 CPU / 内存 / 磁盘 / 负载 / 系统信息 */
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function ServerResources({
  server,
  onProbe,
  probing
}) {
  const resources = server.resources;
  const monitor = server.monitor || {};
  if (!resources) {
    return /*#__PURE__*/_jsxs("div", {
      style: {
        padding: 4
      },
      children: [/*#__PURE__*/_jsx(EmptyState, {
        title: "\u8FD8\u6CA1\u6709\u91C7\u96C6\u6570\u636E",
        hint: server.monitorEnabled === false ? '这台服务器已关闭 SSH 监控。' : '运行 SSH 检测后读取系统指标与真实监听端口。',
        action: /*#__PURE__*/_jsx(Button, {
          variant: "primary",
          icon: "wifi",
          loading: probing,
          onClick: () => onProbe?.(server),
          children: "SSH \u68C0\u6D4B"
        })
      }), monitor.error ? /*#__PURE__*/_jsxs(Notice, {
        tone: "error",
        icon: "alert",
        children: ["\u4E0A\u6B21\u91C7\u96C6\u5931\u8D25\uFF08", formatDateTime(monitor.at), "\uFF09\uFF1A", monitor.error]
      }) : null]
    });
  }
  const memory = resources.memory;
  const disk = resources.disk;
  const diskList = server.metrics?.diskAll || server.metrics?.disk || [];
  return /*#__PURE__*/_jsxs("div", {
    className: "server-res",
    children: [/*#__PURE__*/_jsxs("div", {
      className: "res-grid",
      children: [/*#__PURE__*/_jsx(Meter, {
        label: "CPU \u4F7F\u7528\u7387",
        percent: resources.cpuUsagePercent,
        tone: usageTone(resources.cpuUsagePercent),
        hint: `${resources.cpuCores ?? '—'} 核 · 负载 ${formatLoad(resources.load)}`
      }), /*#__PURE__*/_jsx(Meter, {
        label: "\u5185\u5B58",
        percent: memory?.usedPercent,
        tone: usageTone(memory?.usedPercent),
        hint: memory ? `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}（可用 ${formatBytes(memory.availableBytes)}）` : '未采集'
      }), /*#__PURE__*/_jsx(Meter, {
        label: `磁盘 ${disk?.mount || '/'}`,
        percent: disk?.usePercent,
        tone: usageTone(disk?.usePercent),
        hint: disk ? `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.sizeBytes)}` : '未采集'
      }), /*#__PURE__*/_jsx(Meter, {
        label: "Swap",
        percent: memory?.swapTotalBytes ? memory.swapUsedBytes / memory.swapTotalBytes * 100 : null,
        tone: usageTone(memory?.swapTotalBytes ? memory.swapUsedBytes / memory.swapTotalBytes * 100 : null),
        hint: memory?.swapTotalBytes ? `${formatBytes(memory.swapUsedBytes)} / ${formatBytes(memory.swapTotalBytes)}` : '无 Swap'
      })]
    }), /*#__PURE__*/_jsxs("div", {
      className: "res-facts",
      children: [/*#__PURE__*/_jsx(Fact, {
        icon: "server",
        label: "\u4E3B\u673A\u540D",
        value: resources.hostname || '—'
      }), /*#__PURE__*/_jsx(Fact, {
        icon: "cpu",
        label: "\u7CFB\u7EDF",
        value: resources.os || '—'
      }), /*#__PURE__*/_jsx(Fact, {
        icon: "layers",
        label: "\u5185\u6838",
        value: resources.kernel || '—'
      }), /*#__PURE__*/_jsx(Fact, {
        icon: "clock",
        label: "\u8FD0\u884C\u65F6\u957F",
        value: formatUptime(resources.uptimeSec)
      }), /*#__PURE__*/_jsx(Fact, {
        icon: "user",
        label: "\u767B\u5F55\u7528\u6237",
        value: resources.loginUser || server.username || '—'
      }), /*#__PURE__*/_jsx(Fact, {
        icon: "wifi",
        label: "SSH \u5EF6\u8FDF",
        value: formatLatency(monitor.latencyMs)
      }), /*#__PURE__*/_jsx(Fact, {
        icon: "refresh",
        label: "\u91C7\u96C6\u65F6\u95F4",
        value: formatDateTime(resources.collectedAt)
      }), /*#__PURE__*/_jsx(Fact, {
        icon: "ports",
        label: "\u771F\u5B9E\u76D1\u542C\u7AEF\u53E3",
        value: `${resources.portCount ?? 0} 个`
      })]
    }), diskList.length > 1 ? /*#__PURE__*/_jsx("div", {
      style: {
        marginTop: 12,
        overflowX: 'auto'
      },
      children: /*#__PURE__*/_jsxs("table", {
        className: "table",
        children: [/*#__PURE__*/_jsx("thead", {
          children: /*#__PURE__*/_jsxs("tr", {
            children: [/*#__PURE__*/_jsx("th", {
              children: "\u6302\u8F7D\u70B9"
            }), /*#__PURE__*/_jsx("th", {
              children: "\u6587\u4EF6\u7CFB\u7EDF"
            }), /*#__PURE__*/_jsx("th", {
              children: "\u7C7B\u578B"
            }), /*#__PURE__*/_jsx("th", {
              style: {
                width: 96
              },
              children: "\u5DF2\u7528"
            }), /*#__PURE__*/_jsx("th", {
              style: {
                width: 96
              },
              children: "\u603B\u91CF"
            }), /*#__PURE__*/_jsx("th", {
              style: {
                width: 132
              },
              children: "\u4F7F\u7528\u7387"
            })]
          })
        }), /*#__PURE__*/_jsx("tbody", {
          children: diskList.map(item => /*#__PURE__*/_jsxs("tr", {
            children: [/*#__PURE__*/_jsx("td", {
              className: "mono",
              children: item.mount
            }), /*#__PURE__*/_jsx("td", {
              className: "mono",
              style: {
                color: 'var(--muted)'
              },
              children: item.filesystem
            }), /*#__PURE__*/_jsx("td", {
              style: {
                color: 'var(--muted)'
              },
              children: item.type || '—'
            }), /*#__PURE__*/_jsx("td", {
              children: formatBytes(item.usedBytes)
            }), /*#__PURE__*/_jsx("td", {
              children: formatBytes(item.sizeBytes)
            }), /*#__PURE__*/_jsx("td", {
              children: /*#__PURE__*/_jsxs("span", {
                className: "row",
                style: {
                  gap: 8
                },
                children: [/*#__PURE__*/_jsx("span", {
                  className: "meter__track",
                  style: {
                    flex: 1,
                    minWidth: 48
                  },
                  children: /*#__PURE__*/_jsx("span", {
                    className: "meter__fill",
                    style: {
                      width: `${Math.min(100, item.usePercent)}%`,
                      background: item.usePercent >= 90 ? 'var(--red)' : item.usePercent >= 75 ? 'var(--amber)' : undefined
                    }
                  })
                }), /*#__PURE__*/_jsxs("span", {
                  style: {
                    width: 38,
                    textAlign: 'right'
                  },
                  children: [item.usePercent, "%"]
                })]
              })
            })]
          }, `${item.mount}-${item.filesystem}`))
        })]
      })
    }) : null, monitor.mode === 'ssh' && monitor.online === false ? /*#__PURE__*/_jsxs(Notice, {
      tone: "error",
      icon: "alert",
      children: ["\u6700\u8FD1\u4E00\u6B21 SSH \u91C7\u96C6\u5931\u8D25\uFF1A", monitor.error]
    }) : null]
  });
}