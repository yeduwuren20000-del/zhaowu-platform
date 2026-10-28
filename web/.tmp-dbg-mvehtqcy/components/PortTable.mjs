import { useState } from 'react';
import { Button, EmptyState, StatusDot } from './ui.mjs';
import { auditClass, auditMeta, sourceMeta, statusMeta } from '../utils/format.js';

/**
 * 服务端口表：一行一个真实监听端口。
 * 本地行来自端口扫描，服务器行来自 SSH 采集与资产记录。
 */
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function PortTable({
  rows,
  onScan,
  onOpenUrl,
  onCopyPath,
  onOpenProject,
  emptyHint = '还没有端口记录，先在项目或服务器里登记端口。'
}) {
  const [scanned, setScanned] = useState({});
  if (!rows?.length) return /*#__PURE__*/_jsx(EmptyState, {
    title: "\u6CA1\u6709\u5339\u914D\u7684\u7AEF\u53E3\u8BB0\u5F55",
    hint: emptyHint
  });
  async function handleScan(row) {
    if (!row.port) return;
    setScanned(prev => ({
      ...prev,
      [row.key]: {
        loading: true
      }
    }));
    const result = await onScan?.(row.port);
    setScanned(prev => ({
      ...prev,
      [row.key]: {
        loading: false,
        result
      }
    }));
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
              width: 78
            },
            children: "\u7AEF\u53E3"
          }), /*#__PURE__*/_jsx("th", {
            children: "\u5E94\u7528 / \u670D\u52A1"
          }), /*#__PURE__*/_jsx("th", {
            style: {
              width: 64
            },
            children: "\u73AF\u5883"
          }), /*#__PURE__*/_jsx("th", {
            children: "\u6240\u5C5E\u9879\u76EE / \u670D\u52A1\u5668"
          }), /*#__PURE__*/_jsx("th", {
            children: "\u8DEF\u5F84"
          }), /*#__PURE__*/_jsx("th", {
            style: {
              width: 104
            },
            children: "\u72B6\u6001"
          }), /*#__PURE__*/_jsx("th", {
            style: {
              width: 96
            },
            children: "SSH \u6838\u5BF9"
          }), /*#__PURE__*/_jsx("th", {
            style: {
              width: 168,
              textAlign: 'right'
            },
            children: "\u64CD\u4F5C"
          })]
        })
      }), /*#__PURE__*/_jsx("tbody", {
        children: rows.map(row => {
          const scan = scanned[row.key];
          return /*#__PURE__*/_jsxs("tr", {
            children: [/*#__PURE__*/_jsxs("td", {
              className: "table__port",
              children: [row.port ?? '—', row.pid ? /*#__PURE__*/_jsxs("div", {
                className: "sub",
                children: ["PID ", row.pid]
              }) : null]
            }), /*#__PURE__*/_jsxs("td", {
              children: [/*#__PURE__*/_jsx("div", {
                children: row.app
              }), row.source && row.source !== 'unknown' ? /*#__PURE__*/_jsx("div", {
                className: "sub",
                title: row.sourceDetail || sourceMeta(row.source).hint,
                children: sourceMeta(row.source).text
              }) : null, row.processName ? /*#__PURE__*/_jsx("div", {
                className: "sub tech",
                children: row.processName
              }) : null, scan?.result ? /*#__PURE__*/_jsx("div", {
                className: "sub tech",
                children: scan.result.listening ? `实测占用 ${scan.result.owners.map(owner => `${owner.pid}/${owner.processName || '未知'}`).join('、')}` : '实测：端口空闲'
              }) : null]
            }), /*#__PURE__*/_jsx("td", {
              children: /*#__PURE__*/_jsx("span", {
                className: "status-word muted",
                children: row.env
              })
            }), /*#__PURE__*/_jsxs("td", {
              children: [row.projectId && onOpenProject ? /*#__PURE__*/_jsx("span", {
                className: "link",
                onClick: () => onOpenProject(row.projectId),
                title: "\u8DF3\u5230\u5BF9\u5E94\u7684\u672C\u5730\u9879\u76EE\uFF08\u542B\u5B50\u670D\u52A1\u5217\u8868\uFF09",
                children: row.owner
              }) : /*#__PURE__*/_jsx("span", {
                children: row.owner
              }), row.isSubService ? /*#__PURE__*/_jsx("div", {
                className: "sub",
                children: "\u5B50\u670D\u52A1"
              }) : null, row.host ? /*#__PURE__*/_jsx("div", {
                className: "sub tech",
                children: row.host
              }) : null]
            }), /*#__PURE__*/_jsx("td", {
              children: /*#__PURE__*/_jsx("span", {
                className: "table__path",
                title: row.path,
                children: row.path || '—'
              })
            }), /*#__PURE__*/_jsxs("td", {
              children: [/*#__PURE__*/_jsxs("span", {
                className: "row",
                style: {
                  gap: 6
                },
                children: [/*#__PURE__*/_jsx(StatusDot, {
                  status: row.status
                }), /*#__PURE__*/_jsx("span", {
                  className: "status-word",
                  title: row.statusText,
                  children: statusMeta(row.status).text
                })]
              }), row.conflict ? /*#__PURE__*/_jsx("div", {
                className: "sub status-word is-error",
                children: row.conflict.type === 'duplicate' ? '端口重复' : '被其他进程占用'
              }) : null]
            }), /*#__PURE__*/_jsx("td", {
              children: row.auditState ? /*#__PURE__*/_jsx("span", {
                className: `status-word ${auditClass(row.auditState)}`,
                title: auditMeta(row.auditState).hint,
                children: auditMeta(row.auditState).text
              }) : row.envKey === 'server' ? /*#__PURE__*/_jsx("span", {
                className: "status-word muted",
                children: "\u672A\u91C7\u96C6"
              }) : /*#__PURE__*/_jsx("span", {
                style: {
                  color: 'var(--muted-2)'
                },
                children: "\u2014"
              })
            }), /*#__PURE__*/_jsx("td", {
              children: /*#__PURE__*/_jsxs("div", {
                className: "table__actions",
                children: [/*#__PURE__*/_jsx(Button, {
                  size: "sm",
                  icon: "refresh",
                  loading: scan?.loading,
                  onClick: () => handleScan(row),
                  children: "\u68C0\u6D4B"
                }), /*#__PURE__*/_jsxs("span", {
                  className: "row-actions",
                  children: [row.url ? /*#__PURE__*/_jsx(Button, {
                    size: "sm",
                    icon: "external",
                    onClick: () => onOpenUrl?.(row.url),
                    children: "\u6253\u5F00"
                  }) : null, /*#__PURE__*/_jsx(Button, {
                    size: "sm",
                    icon: "copy",
                    onClick: () => onCopyPath?.(row.path),
                    children: "\u590D\u5236"
                  })]
                })]
              })
            })]
          }, row.key);
        })
      })]
    })
  });
}