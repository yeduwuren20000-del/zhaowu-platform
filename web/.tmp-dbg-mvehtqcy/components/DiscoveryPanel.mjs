import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useToast } from '../hooks/useToast.mjs';
import { ProjectGroupCard, ServiceList } from './ServiceList.mjs';
import { Button, EmptyState, SearchBox, Switch } from './ui.mjs';
import { formatDateTime } from '../utils/format.js';

/** 自动发现面板：默认按项目目录分组，事实字段只来自系统采集 */
import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
export function DiscoveryPanel({
  onRegistered,
  onClose
}) {
  const toast = useToast();
  const [scanning, setScanning] = useState(false);
  const [includeAi, setIncludeAi] = useState(false);
  const [grouping, setGrouping] = useState(null);
  const [latest, setLatest] = useState(null);
  const [busy, setBusy] = useState({});
  const [expanded, setExpanded] = useState({});
  const [query, setQuery] = useState('');
  const [showFiltered, setShowFiltered] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const loadLatest = useCallback(async () => {
    try {
      const [groups, latestData] = await Promise.all([api.discoveryGroups(), api.discoveryLatest()]);
      setGrouping(groups);
      setLatest(latestData);
    } catch (error) {
      toast.error('读取扫描结果失败', error.message);
    }
  }, [toast]);
  useEffect(() => {
    loadLatest();
  }, [loadLatest]);
  const runScan = useCallback(async () => {
    setScanning(true);
    try {
      const result = await api.discoveryScan(includeAi);
      await loadLatest();
      const summary = result.groupSummary || {};
      toast.success(`扫描完成（${result.durationMs}ms）`, `监听端口 ${result.summary.listeningCount} 个 · 聚合出 ${summary.directoryGroups ?? 0} 个项目目录分组 · 待登记 ${summary.unregisteredGroups ?? 0} 组 · 已登记 ${summary.registeredGroups ?? 0} 组 · 过滤 ${result.summary.filtered} 个`);
    } catch (error) {
      toast.error('扫描失败', error.message);
    } finally {
      setScanning(false);
    }
  }, [includeAi, loadLatest, toast]);
  const groups = grouping?.groups || [];
  const loose = grouping?.loose || [];
  const systemServices = grouping?.system || [];
  const summary = grouping?.summary || {};
  const ignored = latest?.ignored || [];
  const aiInfo = latest?.ai || null;
  const visibleGroups = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return groups;
    return groups.filter(group => [group.name, group.projectDir, group.registeredProjectName, ...(group.summary?.portList || []), ...(group.summary?.types || [])].filter(value => value !== null && value !== undefined).some(value => String(value).toLowerCase().includes(text)));
  }, [groups, query]);
  async function withBusy(key, fn, messages) {
    setBusy(prev => ({
      ...prev,
      [key]: true
    }));
    try {
      const data = await fn();
      if (messages?.success) toast.success(messages.success, data?.project?.name || messages.detail);
      await loadLatest();
      await onRegistered?.();
      return data;
    } catch (error) {
      toast.error(messages?.error || '操作失败', error.message);
      return null;
    } finally {
      setBusy(prev => {
        const next = {
          ...prev
        };
        delete next[key];
        return next;
      });
    }
  }
  const registerGroup = (group, primaryFingerprint = null) => withBusy(`grp:${group.id}`, () => api.discoveryRegisterGroup(group.id, {}, primaryFingerprint), {
    success: `已按目录登记「${group.name}」（同目录 ${group.summary.live} 个服务合并为一个项目）`,
    error: '登记项目组失败'
  });
  const ignoreGroup = group => withBusy(`grpign:${group.id}`, async () => {
    const fingerprints = group.services.filter(service => service.live && service.key).map(service => service.key);
    return api.discoveryIgnore(fingerprints, '整组忽略');
  }, {
    success: `已忽略「${group.name}」下的服务`,
    error: '忽略失败'
  });
  const registerSingle = service => withBusy(`reg:${service.key}`, () => api.discoveryRegister(service.key), {
    success: '已登记为独立项目',
    error: '登记失败'
  });
  const associate = (service, projectId) => withBusy(`assoc:${service.key}`, () => api.discoveryAssociate(service.key, projectId), {
    success: '已关联为项目子服务',
    error: '关联失败'
  });

  // ---- 批量登记 ----
  const selectableGroups = groups.filter(group => group.registrationState !== 'registered');
  const toggleSelect = groupId => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);else next.add(groupId);
      return next;
    });
  };
  const selectAll = () => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.size === selectableGroups.length) next.clear();else for (const group of selectableGroups) next.add(group.id);
      return next;
    });
  };
  const exitBatch = () => {
    setBatchMode(false);
    setSelected(new Set());
  };
  const batchRegister = () => withBusy('batch', async () => {
    const data = await api.discoveryRegisterGroups([...selected]);
    const created = data.created ?? 0;
    const skipped = data.skipped ?? 0;
    const failed = data.failed ?? 0;
    setSelected(new Set());
    setBatchMode(false);
    if (created === 0 && skipped > 0) {
      throw new Error(`没有可登记的项目组（${skipped} 组已登记或无可登记服务）`);
    }
    return data;
  }, {
    success: data => {
      const created = data?.created ?? 0;
      const skipped = data?.skipped ?? 0;
      const failed = data?.failed ?? 0;
      return `批量登记完成：成功 ${created} 组${skipped ? ` · 跳过 ${skipped} 组` : ''}${failed ? ` · 失败 ${failed} 组` : ''}`;
    },
    error: '批量登记失败'
  });
  const ignoreService = service => withBusy(`ign:${service.key}`, () => api.discoveryIgnore([service.key], '用户在自动发现面板忽略'), {
    success: '已忽略该服务（后续扫描不再提示）',
    error: '忽略失败'
  });
  const restore = fingerprint => withBusy(`res:${fingerprint}`, () => api.discoveryRestore([fingerprint]), {
    success: '已恢复该服务的提示',
    error: '恢复失败'
  });
  const identify = fingerprint => withBusy(`ai:${fingerprint}`, () => api.discoveryIdentify(fingerprint), {
    success: 'AI 建议已生成（只作为参考，不会改写事实字段）',
    error: 'AI 识别失败'
  });
  return /*#__PURE__*/_jsxs("div", {
    className: "card",
    style: {
      marginBottom: 16
    },
    children: [/*#__PURE__*/_jsxs("header", {
      className: "card__header",
      children: [/*#__PURE__*/_jsxs("div", {
        className: "card__title",
        children: ["\u81EA\u52A8\u53D1\u73B0", grouping?.scanAt ? /*#__PURE__*/_jsxs("span", {
          className: "card__title-sub",
          children: ["\u626B\u63CF\u4E8E ", formatDateTime(grouping.scanAt)]
        }) : null]
      }), /*#__PURE__*/_jsxs("div", {
        className: "card__actions",
        children: [/*#__PURE__*/_jsx(Switch, {
          checked: includeAi,
          onChange: setIncludeAi,
          label: "\u542F\u7528 AI \u8F85\u52A9\u8BC6\u522B"
        }), batchMode ? /*#__PURE__*/_jsx(Button, {
          icon: "x",
          onClick: exitBatch,
          children: "\u9000\u51FA\u6279\u91CF\u9009\u62E9"
        }) : /*#__PURE__*/_jsx(Button, {
          icon: "check",
          disabled: !selectableGroups.length,
          onClick: () => setBatchMode(true),
          title: "\u52FE\u9009\u591A\u4E2A\u5F85\u767B\u8BB0\u7684\u9879\u76EE\u7EC4\uFF0C\u4E00\u6B21\u6027\u767B\u8BB0",
          children: "\u6279\u91CF\u767B\u8BB0"
        }), /*#__PURE__*/_jsx(Button, {
          variant: "primary",
          icon: "refresh",
          loading: scanning,
          onClick: runScan,
          children: "\u7ACB\u5373\u626B\u63CF"
        }), onClose ? /*#__PURE__*/_jsx(Button, {
          icon: "x",
          onClick: onClose
        }) : null]
      })]
    }), /*#__PURE__*/_jsxs("div", {
      className: "card__body",
      children: [/*#__PURE__*/_jsxs("div", {
        className: "footnote",
        style: {
          marginBottom: 10
        },
        children: ["\u540C\u4E00\u4E2A ", /*#__PURE__*/_jsx("span", {
          className: "mono",
          children: "projectDir"
        }), " \u4E0B\u7684\u591A\u4E2A\u8FDB\u7A0B/\u7AEF\u53E3\u805A\u5408\u4E3A\u4E00\u4E2A\u9879\u76EE\u7EC4\uFF0C\u65E0\u76EE\u5F55\u7684\u670D\u52A1\u6309 PID \u5355\u72EC\u5206\u7EC4\uFF1BPID\u3001\u7AEF\u53E3\u3001\u8DEF\u5F84\u3001\u547D\u4EE4\u884C\u5747\u6765\u81EA\u7CFB\u7EDF\u5B9E\u65F6\u91C7\u96C6\uFF0C\u626B\u63CF\u53EA\u8BFB\u53D6\u9879\u76EE\u5143\u6570\u636E\u6587\u4EF6\uFF0C", /*#__PURE__*/_jsx("b", {
          children: "\u4E0D\u4F1A\u6267\u884C"
        }), "\u76EE\u6807\u9879\u76EE\u7684\u4EFB\u4F55\u811A\u672C\u3002"]
      }), !grouping ? /*#__PURE__*/_jsx(EmptyState, {
        title: "\u8FD8\u6CA1\u6709\u626B\u63CF\u7ED3\u679C",
        hint: "\u70B9\u300C\u7ACB\u5373\u626B\u63CF\u300D\u4F1A\u8BFB\u53D6\u672C\u673A\u76D1\u542C\u7AEF\u53E3\u3001\u8FDB\u7A0B\u4E8B\u5B9E\u4E0E\u9879\u76EE\u5143\u6570\u636E\uFF0C\u5E76\u6309\u9879\u76EE\u76EE\u5F55\u805A\u5408\u3002"
      }) : /*#__PURE__*/_jsxs(_Fragment, {
        children: [/*#__PURE__*/_jsxs("div", {
          className: "row row--wrap",
          style: {
            gap: 10,
            margin: '10px 0'
          },
          children: [/*#__PURE__*/_jsxs("span", {
            className: "footnote",
            children: ["\u7AEF\u53E3 ", summary.ports ?? 0, " \xB7 \u9879\u76EE\u7EC4 ", summary.directoryGroups ?? 0, "\uFF08\u5F85\u767B\u8BB0 ", summary.unregisteredGroups ?? 0, " / \u5DF2\u767B\u8BB0 ", summary.registeredGroups ?? 0, "\uFF09\xB7 \u65E0\u76EE\u5F55 ", summary.looseGroups ?? 0, " \xB7 \u5DF2\u8FC7\u6EE4 ", summary.systemServices ?? 0, " \xB7 \u5DF2\u5FFD\u7565 ", summary.ignoredServices ?? 0, summary.newSubServices ? ` · 新子服务 ${summary.newSubServices}` : '']
          }), summary.conflicts ? /*#__PURE__*/_jsxs("span", {
            className: "status-word is-error",
            children: ["\u51B2\u7A81 ", summary.conflicts]
          }) : null, /*#__PURE__*/_jsx("div", {
            className: "spacer"
          }), batchMode ? /*#__PURE__*/_jsx(Button, {
            size: "sm",
            icon: "check",
            onClick: selectAll,
            title: selected.size === selectableGroups.length ? '取消全选' : '全选待登记项目组',
            children: selected.size === selectableGroups.length && selectableGroups.length > 0 ? '取消全选' : '全选待登记'
          }) : null, /*#__PURE__*/_jsx(SearchBox, {
            value: query,
            onChange: setQuery,
            placeholder: "\u7B5B\u9009\u9879\u76EE\u7EC4\uFF08\u540D\u79F0/\u76EE\u5F55/\u7AEF\u53E3\uFF09\u2026",
            width: 230
          })]
        }), aiInfo && !aiInfo.available ? /*#__PURE__*/_jsxs("div", {
          className: "footnote",
          style: {
            marginBottom: 10
          },
          children: ["AI \u8F85\u52A9\u8BC6\u522B\u672A\u542F\u7528\uFF1A", aiInfo.note, "\u3002\u5019\u9009\u5168\u90E8\u7531\u786E\u5B9A\u6027\u89C4\u5219\u8BC6\u522B\u3002"]
        }) : grouping?.aiNote ? /*#__PURE__*/_jsx("div", {
          className: "footnote",
          style: {
            marginBottom: 10
          },
          children: grouping.aiNote
        }) : null, visibleGroups.length === 0 ? /*#__PURE__*/_jsx(EmptyState, {
          title: groups.length === 0 ? '没有发现任何项目组' : '没有匹配的项目组',
          hint: groups.length === 0 ? '启动一个带项目目录的服务后重新扫描即可发现。' : '换个关键字试试。'
        }) : /*#__PURE__*/_jsx("div", {
          className: "stack",
          children: visibleGroups.map(group => /*#__PURE__*/_jsx(ProjectGroupCard, {
            group: group,
            expanded: expanded[group.id] !== false,
            onToggle: id => setExpanded(prev => ({
              ...prev,
              [id]: prev[id] === false
            })),
            busy: busy,
            onRegisterGroup: registerGroup,
            onIgnoreGroup: ignoreGroup,
            onRegisterSingle: registerSingle,
            onEditRegister: registerSingle,
            onAssociate: service => associate(service, group.registeredProjectId),
            onIgnoreService: ignoreService,
            selectable: batchMode,
            selected: selected.has(group.id),
            onToggleSelect: toggleSelect
          }, group.id))
        }), loose.length > 0 ? /*#__PURE__*/_jsxs("div", {
          style: {
            marginTop: 14
          },
          children: [/*#__PURE__*/_jsxs("div", {
            className: "footnote",
            style: {
              marginBottom: 8
            },
            children: ["\u672A\u8BC6\u522B\u9879\u76EE\u76EE\u5F55\u7684\u72EC\u7ACB\u670D\u52A1 ", loose.length, " \u7EC4\uFF0C\u6309\u8FDB\u7A0B\uFF08PID\uFF09\u5206\u7EC4\uFF0C\u4E0D\u4E0E\u4EFB\u4F55\u9879\u76EE\u5408\u5E76"]
          }), loose.map(group => /*#__PURE__*/_jsxs("div", {
            style: {
              marginBottom: 10
            },
            children: [/*#__PURE__*/_jsxs("div", {
              className: "row row--wrap",
              style: {
                gap: 8,
                marginBottom: 6
              },
              children: [/*#__PURE__*/_jsx("span", {
                className: "docker-name",
                children: group.name
              }), /*#__PURE__*/_jsxs("span", {
                className: "footnote tech",
                children: ["\u7AEF\u53E3 ", group.summary.portList.join('、') || '—', " \xB7 \u8FDB\u7A0B ", group.summary.processes]
              }), aiInfo?.available && group.services.some(service => service.candidate?.aiEligible) ? /*#__PURE__*/_jsx(Button, {
                size: "sm",
                icon: "cpu",
                loading: busy[`ai:${group.services[0].key}`],
                onClick: () => identify(group.services[0].key),
                children: "AI \u8BC6\u522B"
              }) : null]
            }), /*#__PURE__*/_jsx(ServiceList, {
              services: group.services,
              busy: busy,
              onRegisterSingle: registerSingle,
              onIgnore: ignoreService,
              onEditRegister: registerSingle,
              compact: true
            })]
          }, group.id))]
        }) : null, /*#__PURE__*/_jsxs("div", {
          className: "row",
          style: {
            gap: 10,
            marginTop: 14
          },
          children: [/*#__PURE__*/_jsxs(Button, {
            size: "sm",
            icon: showFiltered ? 'chevronDown' : 'chevronRight',
            onClick: () => setShowFiltered(prev => !prev),
            children: ["\u7CFB\u7EDF\u4E0E\u975E\u5F00\u53D1\u8FDB\u7A0B\uFF08", systemServices.length, "\uFF09"]
          }), /*#__PURE__*/_jsxs(Button, {
            size: "sm",
            icon: showIgnored ? 'chevronDown' : 'chevronRight',
            onClick: () => setShowIgnored(prev => !prev),
            children: ["\u5DF2\u5FFD\u7565\uFF08", ignored.length, "\uFF09"]
          })]
        }), showFiltered ? /*#__PURE__*/_jsx("div", {
          style: {
            marginTop: 10,
            maxHeight: 260,
            overflowY: 'auto'
          },
          children: /*#__PURE__*/_jsxs("table", {
            className: "table",
            children: [/*#__PURE__*/_jsx("thead", {
              children: /*#__PURE__*/_jsxs("tr", {
                children: [/*#__PURE__*/_jsx("th", {
                  style: {
                    width: 90
                  },
                  children: "\u7AEF\u53E3"
                }), /*#__PURE__*/_jsx("th", {
                  style: {
                    width: 90
                  },
                  children: "PID"
                }), /*#__PURE__*/_jsx("th", {
                  children: "\u8FDB\u7A0B"
                }), /*#__PURE__*/_jsx("th", {
                  children: "\u8FC7\u6EE4\u539F\u56E0"
                })]
              })
            }), /*#__PURE__*/_jsx("tbody", {
              children: systemServices.map(item => /*#__PURE__*/_jsxs("tr", {
                children: [/*#__PURE__*/_jsx("td", {
                  className: "table__port",
                  children: item.port
                }), /*#__PURE__*/_jsx("td", {
                  className: "tech",
                  children: item.pid
                }), /*#__PURE__*/_jsx("td", {
                  className: "tech",
                  children: item.processName || '—'
                }), /*#__PURE__*/_jsx("td", {
                  style: {
                    color: 'var(--muted)'
                  },
                  children: item.filterReason
                })]
              }, item.fingerprint))
            })]
          })
        }) : null, showIgnored ? /*#__PURE__*/_jsx("div", {
          style: {
            marginTop: 10,
            maxHeight: 260,
            overflowY: 'auto'
          },
          children: ignored.length === 0 ? /*#__PURE__*/_jsx(EmptyState, {
            title: "\u6CA1\u6709\u5FFD\u7565\u8BB0\u5F55",
            hint: "\u88AB\u5FFD\u7565\u7684\u670D\u52A1\u4F1A\u8BB0\u5F55\u6307\u7EB9\uFF08\u4E0E PID \u65E0\u5173\uFF09\uFF0C\u540E\u7EED\u626B\u63CF\u4E0D\u518D\u63D0\u793A\u3002"
          }) : /*#__PURE__*/_jsxs("table", {
            className: "table",
            children: [/*#__PURE__*/_jsx("thead", {
              children: /*#__PURE__*/_jsxs("tr", {
                children: [/*#__PURE__*/_jsx("th", {
                  children: "\u6307\u7EB9"
                }), /*#__PURE__*/_jsx("th", {
                  children: "\u6807\u8BB0"
                }), /*#__PURE__*/_jsx("th", {
                  children: "\u5FFD\u7565\u65F6\u95F4"
                }), /*#__PURE__*/_jsx("th", {
                  style: {
                    width: 100,
                    textAlign: 'right'
                  },
                  children: "\u64CD\u4F5C"
                })]
              })
            }), /*#__PURE__*/_jsx("tbody", {
              children: ignored.map(item => /*#__PURE__*/_jsxs("tr", {
                children: [/*#__PURE__*/_jsx("td", {
                  className: "mono",
                  children: item.fingerprint
                }), /*#__PURE__*/_jsx("td", {
                  children: item.label || '—'
                }), /*#__PURE__*/_jsx("td", {
                  style: {
                    color: 'var(--muted)'
                  },
                  children: formatDateTime(item.at)
                }), /*#__PURE__*/_jsx("td", {
                  children: /*#__PURE__*/_jsx("div", {
                    className: "table__actions",
                    children: /*#__PURE__*/_jsx(Button, {
                      size: "sm",
                      icon: "refresh",
                      loading: busy[`res:${item.fingerprint}`],
                      onClick: () => restore(item.fingerprint),
                      children: "\u6062\u590D"
                    })
                  })
                })]
              }, item.fingerprint))
            })]
          })
        }) : null]
      }), batchMode && selected.size > 0 ? /*#__PURE__*/_jsxs("div", {
        className: "batch-bar",
        children: [/*#__PURE__*/_jsxs("span", {
          className: "batch-bar__info",
          children: ["\u5DF2\u9009 ", /*#__PURE__*/_jsx("b", {
            children: selected.size
          }), " \u4E2A\u5F85\u767B\u8BB0\u9879\u76EE\u7EC4"]
        }), /*#__PURE__*/_jsx(Button, {
          size: "sm",
          icon: "x",
          onClick: exitBatch,
          children: "\u53D6\u6D88"
        }), /*#__PURE__*/_jsxs(Button, {
          size: "sm",
          variant: "primary",
          icon: "check",
          loading: busy.batch,
          onClick: batchRegister,
          children: ["\u767B\u8BB0\u6240\u9009 ", selected.size, " \u7EC4"]
        })]
      }) : null]
    })]
  });
}