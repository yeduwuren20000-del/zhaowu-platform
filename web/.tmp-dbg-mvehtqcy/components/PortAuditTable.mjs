import { Button, EmptyState, Notice } from './ui.mjs';
import { auditClass, auditMeta, formatDateTime } from '../utils/format.js';

/**
 * 端口核对表：真实监听端口 vs 工作台登记的 APP/端口
 *   ok                     —— 正常（已登记且正在监听）
 *   recordedNotListening   —— 记录存在但未监听
 *   listeningNotRecorded   —— 监听但未登记
 */
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
export function PortAuditTable({
  server,
  audit,
  busy = {},
  onProbeApp,
  onEditApp,
  onRegisterPort,
  onRefresh,
  loading
}) {
  const items = audit?.items || [];
  const summary = audit?.summary;
  if (!server.ssh?.at) {
    return /*#__PURE__*/_jsx(EmptyState, {
      title: "\u8FD8\u6CA1\u6709\u505A\u8FC7 SSH \u91C7\u96C6",
      hint: "\u8FD0\u884C SSH \u68C0\u6D4B\u540E\u8BFB\u53D6\u771F\u5B9E\u76D1\u542C\u7AEF\u53E3\uFF08ss -lntup\uFF09\u3002",
      action: /*#__PURE__*/_jsx(Button, {
        variant: "primary",
        icon: "wifi",
        loading: loading,
        onClick: () => onRefresh?.(server),
        children: "SSH \u68C0\u6D4B"
      })
    });
  }
  if (!server.ssh.ok) {
    return /*#__PURE__*/_jsxs("div", {
      children: [/*#__PURE__*/_jsxs(Notice, {
        tone: "error",
        icon: "alert",
        children: ["\u4E0A\u6B21\u91C7\u96C6\u5931\u8D25\uFF08", formatDateTime(server.ssh.at), "\uFF09\uFF1A", server.ssh.error]
      }), /*#__PURE__*/_jsx("div", {
        style: {
          marginTop: 10
        },
        children: /*#__PURE__*/_jsx(Button, {
          icon: "refresh",
          loading: loading,
          onClick: () => onRefresh?.(server),
          children: "\u91CD\u65B0\u68C0\u6D4B"
        })
      })]
    });
  }
  return /*#__PURE__*/_jsxs("div", {
    children: [/*#__PURE__*/_jsxs("div", {
      className: "row row--wrap",
      style: {
        marginBottom: 10,
        gap: 10
      },
      children: [/*#__PURE__*/_jsxs("span", {
        className: "footnote",
        children: ["\u5171 ", /*#__PURE__*/_jsx("b", {
          children: items.length
        }), " \u6761 \xB7 \u6B63\u5E38 ", /*#__PURE__*/_jsx("b", {
          children: summary?.ok ?? 0
        }), summary?.recordedNotListening ? /*#__PURE__*/_jsxs("span", {
          className: "status-word is-warn",
          children: [" \xB7 \u8BB0\u5F55\u672A\u76D1\u542C ", summary.recordedNotListening]
        }) : null, summary?.listeningNotRecorded ? /*#__PURE__*/_jsxs("span", {
          className: "status-word is-error",
          children: [" \xB7 \u76D1\u542C\u672A\u767B\u8BB0 ", summary.listeningNotRecorded]
        }) : null]
      }), /*#__PURE__*/_jsxs("span", {
        className: "footnote",
        children: ["\u771F\u5B9E\u76D1\u542C ", summary?.totalListening ?? 0, " \u4E2A\u7AEF\u53E3 \xB7 \u91C7\u96C6\u4E8E ", formatDateTime(server.metrics?.collectedAt)]
      }), /*#__PURE__*/_jsx("div", {
        className: "spacer"
      }), /*#__PURE__*/_jsx(Button, {
        size: "sm",
        icon: "refresh",
        loading: loading,
        onClick: () => onRefresh?.(server),
        children: "\u91CD\u65B0\u91C7\u96C6"
      })]
    }), items.length === 0 ? /*#__PURE__*/_jsx(EmptyState, {
      title: "\u6CA1\u6709\u53EF\u6BD4\u5BF9\u7684\u7AEF\u53E3",
      hint: "\u6DFB\u52A0 APP \u8BB0\u5F55\u540E\u5373\u53EF\u4E0E\u771F\u5B9E\u76D1\u542C\u7AEF\u53E3\u6838\u5BF9\u3002"
    }) : /*#__PURE__*/_jsx("div", {
      style: {
        overflowX: 'auto'
      },
      children: /*#__PURE__*/_jsxs("table", {
        className: "table",
        children: [/*#__PURE__*/_jsx("thead", {
          children: /*#__PURE__*/_jsxs("tr", {
            children: [/*#__PURE__*/_jsx("th", {
              style: {
                width: 150
              },
              children: "\u6838\u5BF9\u72B6\u6001"
            }), /*#__PURE__*/_jsx("th", {
              style: {
                width: 74
              },
              children: "\u7AEF\u53E3"
            }), /*#__PURE__*/_jsx("th", {
              children: "APP / \u8FDB\u7A0B"
            }), /*#__PURE__*/_jsx("th", {
              children: "\u76D1\u542C\u4FE1\u606F"
            }), /*#__PURE__*/_jsx("th", {
              children: "\u90E8\u7F72\u8DEF\u5F84"
            }), /*#__PURE__*/_jsx("th", {
              style: {
                width: 168,
                textAlign: 'right'
              },
              children: "\u64CD\u4F5C"
            })]
          })
        }), /*#__PURE__*/_jsx("tbody", {
          children: items.map(item => {
            const meta = auditMeta(item.state);
            const key = `${item.state}-${item.port}-${item.appId || item.appName}`;
            return /*#__PURE__*/_jsxs("tr", {
              children: [/*#__PURE__*/_jsx("td", {
                children: /*#__PURE__*/_jsx("span", {
                  className: `status-word ${auditClass(item.state)}`,
                  title: meta.hint,
                  children: meta.text
                })
              }), /*#__PURE__*/_jsx("td", {
                className: "table__port",
                children: item.port ?? '—'
              }), /*#__PURE__*/_jsxs("td", {
                children: [/*#__PURE__*/_jsx("div", {
                  children: item.appName
                }), item.listen?.process ? /*#__PURE__*/_jsxs("div", {
                  className: "mono",
                  style: {
                    fontSize: 11.5,
                    color: 'var(--muted-2)'
                  },
                  children: [item.listen.process, item.listen.pid ? ` · PID ${item.listen.pid}` : '']
                }) : null]
              }), /*#__PURE__*/_jsx("td", {
                children: item.listen ? /*#__PURE__*/_jsxs("span", {
                  className: "mono",
                  style: {
                    fontSize: 12
                  },
                  children: [item.listen.proto?.toUpperCase(), " ", item.listen.address]
                }) : /*#__PURE__*/_jsx("span", {
                  style: {
                    color: 'var(--muted-2)'
                  },
                  children: "\u672A\u76D1\u542C"
                })
              }), /*#__PURE__*/_jsx("td", {
                children: /*#__PURE__*/_jsx("span", {
                  className: "table__path",
                  title: item.deployPath,
                  children: item.deployPath || '—'
                })
              }), /*#__PURE__*/_jsx("td", {
                children: /*#__PURE__*/_jsx("div", {
                  className: "table__actions",
                  children: item.appId ? /*#__PURE__*/_jsxs(_Fragment, {
                    children: [/*#__PURE__*/_jsx(Button, {
                      size: "sm",
                      icon: "wifi",
                      loading: busy[`app:${server.id}:${item.appId}`],
                      onClick: () => onProbeApp?.(server, {
                        id: item.appId,
                        name: item.appName,
                        port: item.port
                      }),
                      children: "\u7AEF\u53E3\u63A2\u6D4B"
                    }), /*#__PURE__*/_jsx("span", {
                      className: "row-actions",
                      children: /*#__PURE__*/_jsx(Button, {
                        size: "sm",
                        icon: "edit",
                        onClick: () => onEditApp?.(server, (server.apps || []).find(app => app.id === item.appId)),
                        children: "\u7F16\u8F91"
                      })
                    })]
                  }) : /*#__PURE__*/_jsx(Button, {
                    size: "sm",
                    variant: "primary",
                    icon: "plus",
                    onClick: () => onRegisterPort?.(server, {
                      name: item.listen?.process || item.appName || '',
                      port: item.port,
                      status: 'running',
                      remark: `由 SSH 端口核对登记（${item.listen?.proto?.toUpperCase() || ''} ${item.listen?.address || ''}）`
                    }),
                    children: "\u767B\u8BB0\u4E3A APP"
                  })
                })
              })]
            }, key);
          })
        })]
      })
    })]
  });
}