import { Icon } from './Icons.mjs';
import { Button, EmptyState, StatusDot, statusLabel } from './ui.mjs';
import { formatBytes, formatDuration, formatLatency, formatUptime, groupStatusWord, timeAgo } from '../utils/format.js';

/**
 * 子服务列表（第五阶段）：一个项目组下面的多个进程/端口。
 * 每个子服务都保留自己的事实字段（PID、端口、地址、进程名、命令行、启动时间）。
 */
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function ServiceList({
  services = [],
  busy = {},
  onAssociate,
  onIgnore,
  onDissociate,
  onRegisterSingle,
  onEditRegister,
  showProject = false,
  compact = false,
  emptyText = '这个项目组下暂时没有监听中的进程。'
}) {
  if (!services.length) return /*#__PURE__*/_jsx(EmptyState, {
    title: emptyText
  });
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
              width: 84
            },
            children: "\u72B6\u6001"
          }), /*#__PURE__*/_jsx("th", {
            style: {
              width: 64
            },
            children: "\u7AEF\u53E3"
          }), /*#__PURE__*/_jsx("th", {
            children: "\u670D\u52A1 / \u7C7B\u578B"
          }), /*#__PURE__*/_jsx("th", {
            style: {
              width: 170
            },
            children: "\u8FDB\u7A0B\uFF08PID / \u540D\u79F0\uFF09"
          }), /*#__PURE__*/_jsx("th", {
            style: {
              width: 132
            },
            children: "\u76D1\u542C\u5730\u5740"
          }), showProject ? /*#__PURE__*/_jsx("th", {
            style: {
              width: 120
            },
            children: "\u6240\u5C5E\u9879\u76EE"
          }) : null, /*#__PURE__*/_jsx("th", {
            children: "\u547D\u4EE4\u884C"
          }), /*#__PURE__*/_jsx("th", {
            style: {
              width: 84
            },
            children: "\u8FD0\u884C\u65F6\u957F"
          }), /*#__PURE__*/_jsx("th", {
            style: {
              width: 186,
              textAlign: 'right'
            },
            children: "\u64CD\u4F5C"
          })]
        })
      }), /*#__PURE__*/_jsx("tbody", {
        children: services.map(service => {
          const live = service.live !== false;
          const pid = service.livePid ?? service.pid;
          const processName = service.liveProcessName || service.processName;
          const key = service.key || service.fingerprint || service.id;
          return /*#__PURE__*/_jsxs("tr", {
            children: [/*#__PURE__*/_jsx("td", {
              children: /*#__PURE__*/_jsxs("span", {
                className: "row",
                style: {
                  gap: 6
                },
                children: [/*#__PURE__*/_jsx(StatusDot, {
                  status: live ? 'running' : 'stopped'
                }), /*#__PURE__*/_jsx("span", {
                  className: "status-word",
                  children: statusLabel(live ? 'running' : 'stopped')
                })]
              })
            }), /*#__PURE__*/_jsx("td", {
              className: "table__port",
              children: service.port ?? '—'
            }), /*#__PURE__*/_jsxs("td", {
              children: [/*#__PURE__*/_jsxs("span", {
                className: "row",
                style: {
                  gap: 7
                },
                children: [/*#__PURE__*/_jsx("span", {
                  children: service.serviceName || service.name
                }), service.isNewSubService ? /*#__PURE__*/_jsx("span", {
                  className: "status-word is-warn",
                  children: "\u65B0\u53D1\u73B0"
                }) : null, !live ? /*#__PURE__*/_jsx("span", {
                  className: "status-word muted",
                  children: "\u4EC5\u8BB0\u5F55"
                }) : null, service.ignored ? /*#__PURE__*/_jsx("span", {
                  className: "status-word muted",
                  children: "\u5DF2\u5FFD\u7565"
                }) : null]
              }), /*#__PURE__*/_jsx("div", {
                className: "tech muted",
                children: service.type || '—'
              })]
            }), /*#__PURE__*/_jsxs("td", {
              children: [/*#__PURE__*/_jsx("span", {
                className: "tech",
                children: pid ?? '—'
              }), /*#__PURE__*/_jsx("div", {
                className: "tech",
                style: {
                  color: 'var(--muted-2)'
                },
                children: processName || '—'
              }), service.parentName ? /*#__PURE__*/_jsxs("div", {
                className: "tech",
                style: {
                  color: 'var(--muted-2)'
                },
                children: ["\u7236 ", service.parentName]
              }) : null]
            }), /*#__PURE__*/_jsx("td", {
              className: "tech",
              style: {
                color: 'var(--muted)'
              },
              children: service.liveAddress || service.address || '—'
            }), showProject ? /*#__PURE__*/_jsx("td", {
              children: service.registeredProjectName || service.declaredFrom?.projectName || '—'
            }) : null, /*#__PURE__*/_jsx("td", {
              children: /*#__PURE__*/_jsx("span", {
                className: "tech",
                style: {
                  color: 'var(--muted-2)',
                  display: 'inline-block',
                  maxWidth: compact ? 200 : 320,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  verticalAlign: 'bottom'
                },
                title: service.commandLine,
                children: service.commandLine || (live ? '（进程信息不可读）' : '来自项目记录')
              })
            }), /*#__PURE__*/_jsx("td", {
              className: "tech",
              style: {
                color: 'var(--muted)'
              },
              children: live ? formatUptime(Math.round((service.uptimeMs || 0) / 1000)) : '—'
            }), /*#__PURE__*/_jsx("td", {
              children: /*#__PURE__*/_jsxs("div", {
                className: "table__actions",
                children: [service.isNewSubService && onAssociate ? /*#__PURE__*/_jsx(Button, {
                  size: "sm",
                  icon: "plus",
                  loading: busy[`assoc:${service.key}`],
                  onClick: () => onAssociate(service),
                  title: "\u5173\u8054\u4E3A\u5F53\u524D\u9879\u76EE\u7684\u5B50\u670D\u52A1",
                  children: "\u5173\u8054"
                }) : null, live && !service.registeredProjectId && onRegisterSingle ? /*#__PURE__*/_jsx(Button, {
                  size: "sm",
                  icon: "check",
                  loading: busy[`reg:${service.key}`],
                  onClick: () => onRegisterSingle(service),
                  children: "\u767B\u8BB0"
                }) : null, /*#__PURE__*/_jsxs("span", {
                  className: "row-actions",
                  children: [!live && onDissociate ? /*#__PURE__*/_jsx(Button, {
                    size: "sm",
                    icon: "x",
                    loading: busy[`dissoc:${service.id}`],
                    onClick: () => onDissociate(service),
                    children: "\u89E3\u9664\u5173\u8054"
                  }) : null, live && !service.registeredProjectId && onEditRegister ? /*#__PURE__*/_jsx(Button, {
                    size: "sm",
                    icon: "edit",
                    onClick: () => onEditRegister(service),
                    children: "\u7F16\u8F91\u767B\u8BB0"
                  }) : null, live && service.registrationState !== 'ignored' && onIgnore ? /*#__PURE__*/_jsx(Button, {
                    size: "sm",
                    icon: "x",
                    loading: busy[`ign:${service.key}`],
                    onClick: () => onIgnore(service),
                    children: "\u5FFD\u7565"
                  }) : null]
                })]
              })
            })]
          }, key);
        })
      })]
    })
  });
}

/** 项目组行（未登记）：一行给出名称、状态、技术栈、目录与端口/进程数量，展开看子服务 */
export function ProjectGroupCard({
  group,
  expanded,
  onToggle,
  busy = {},
  onRegisterGroup,
  onIgnoreGroup,
  onRegisterSingle,
  onEditRegister,
  onAssociate,
  onIgnoreService,
  selectable = false,
  selected = false,
  onToggleSelect = null
}) {
  const counts = group.summary || {};
  const portList = counts.portList || [];
  const stackKinds = group.stack?.kinds || [];
  const unregistered = group.registrationState !== 'registered';
  return /*#__PURE__*/_jsxs("div", {
    className: `group-card ${group.status === 'conflict' ? 'group-card--conflict' : ''}`,
    children: [/*#__PURE__*/_jsxs("div", {
      className: "group-card__head",
      onClick: () => onToggle?.(group.id),
      children: [selectable && unregistered ? /*#__PURE__*/_jsx("span", {
        className: `group-card__check ${selected ? 'is-checked' : ''}`,
        onClick: event => {
          event.stopPropagation();
          onToggleSelect?.(group.id);
        },
        role: "checkbox",
        "aria-checked": selected,
        title: selected ? '取消选择' : '选择此组批量登记',
        children: /*#__PURE__*/_jsx(Icon, {
          name: selected ? 'check' : 'square',
          size: 17
        })
      }) : null, /*#__PURE__*/_jsx(Icon, {
        name: expanded ? 'chevronDown' : 'chevronRight',
        size: 14,
        className: `chevron ${expanded ? 'is-open' : ''}`
      }), /*#__PURE__*/_jsxs("div", {
        style: {
          minWidth: 0,
          flex: 1
        },
        children: [/*#__PURE__*/_jsxs("div", {
          className: "group-card__title",
          children: [/*#__PURE__*/_jsx(StatusDot, {
            status: group.status === 'all-stopped' ? 'stopped' : group.status === 'conflict' ? 'conflict' : 'running'
          }), /*#__PURE__*/_jsx("span", {
            className: "group-card__name",
            children: group.name
          }), /*#__PURE__*/_jsx("span", {
            className: `status-word ${group.status === 'conflict' ? 'is-error' : group.status === 'partial-running' ? 'is-warn' : ''}`,
            children: groupStatusWord(group.status)
          }), /*#__PURE__*/_jsx("span", {
            className: `status-word ${unregistered ? 'is-warn' : 'muted'}`,
            children: unregistered ? '待登记' : '已登记'
          }), stackKinds.length ? /*#__PURE__*/_jsx("span", {
            className: "tech muted",
            children: stackKinds.join(' · ')
          }) : null, counts.newSubServices > 0 ? /*#__PURE__*/_jsxs("span", {
            className: "status-word is-warn",
            children: ["\u65B0\u5B50\u670D\u52A1 ", counts.newSubServices]
          }) : null]
        }), /*#__PURE__*/_jsxs("div", {
          className: "group-card__facts",
          children: [/*#__PURE__*/_jsx("span", {
            className: "tech",
            title: group.projectDir,
            children: group.projectDir || '未识别目录'
          }), /*#__PURE__*/_jsxs("span", {
            children: ["\u7AEF\u53E3 ", /*#__PURE__*/_jsx("b", {
              children: portList.length ? portList.join(' ') : '—'
            })]
          }), /*#__PURE__*/_jsxs("span", {
            children: ["\u8FDB\u7A0B ", /*#__PURE__*/_jsx("b", {
              children: counts.processes ?? 0
            })]
          }), /*#__PURE__*/_jsxs("span", {
            children: ["\u8FD0\u884C ", /*#__PURE__*/_jsxs("b", {
              children: [counts.live ?? 0, "/", counts.services ?? 0]
            })]
          }), group.registeredProjectName && group.registeredProjectName !== group.name ? /*#__PURE__*/_jsxs("span", {
            children: ["\u9879\u76EE ", /*#__PURE__*/_jsx("b", {
              children: group.registeredProjectName
            })]
          }) : null]
        })]
      }), /*#__PURE__*/_jsxs("div", {
        className: "group-card__actions",
        onClick: event => event.stopPropagation(),
        children: [unregistered ? /*#__PURE__*/_jsx(Button, {
          size: "sm",
          variant: "primary",
          icon: "check",
          loading: busy[`grp:${group.id}`],
          onClick: () => onRegisterGroup?.(group),
          title: "\u53EA\u521B\u5EFA\u4E00\u4E2A\u9879\u76EE\uFF0C\u540C\u76EE\u5F55\u7684\u5176\u5B83\u670D\u52A1\u4F5C\u4E3A\u5B50\u670D\u52A1",
          children: "\u767B\u8BB0"
        }) : null, unregistered ? /*#__PURE__*/_jsx("span", {
          className: "row-actions",
          children: /*#__PURE__*/_jsx(Button, {
            size: "sm",
            icon: "x",
            loading: busy[`grpign:${group.id}`],
            onClick: () => onIgnoreGroup?.(group),
            children: "\u5168\u90E8\u5FFD\u7565"
          })
        }) : null]
      })]
    }), expanded ? /*#__PURE__*/_jsxs("div", {
      className: "group-card__body",
      children: [group.conflicts?.length ? /*#__PURE__*/_jsxs("div", {
        className: "notice notice--error",
        style: {
          marginBottom: 10
        },
        children: [/*#__PURE__*/_jsx(Icon, {
          name: "alert",
          size: 14,
          style: {
            marginTop: 2,
            flex: '0 0 auto'
          }
        }), /*#__PURE__*/_jsx("div", {
          children: group.conflicts.map(conflict => /*#__PURE__*/_jsx("div", {
            children: conflict.message
          }, `${conflict.port}-${conflict.type}`))
        })]
      }) : null, /*#__PURE__*/_jsx(ServiceList, {
        services: group.services,
        busy: busy,
        onAssociate: onAssociate,
        onIgnore: onIgnoreService,
        onRegisterSingle: onRegisterSingle,
        onEditRegister: onEditRegister
      })]
    }) : null]
  });
}
export { formatBytes, formatDuration, formatLatency, timeAgo };