import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAsync, usePolling } from '../hooks/useAsync.js';
import { useProjectActions } from '../hooks/useProjectActions.js';
import { useToast } from '../hooks/useToast.mjs';
import { ProjectCard } from '../components/ProjectCard.mjs';
import { ProjectFormModal } from '../components/forms.mjs';
import { DiscoveryPanel } from '../components/DiscoveryPanel.mjs';
import { ProjectGroupCard, ServiceList } from '../components/ServiceList.mjs';
import { PageHint } from '../components/PageHint.mjs';
import { ProjectResources } from '../components/ProjectResources.mjs';
import { ProjectTimeline } from '../components/EventTimeline.mjs';
import { Icon } from '../components/Icons.mjs';
import { Button, ConfirmDialog, EmptyState, ErrorNotice, Modal, Notice, SearchBox, SkeletonList, Switch, Tabs } from '../components/ui.mjs';
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
const FILTERS = [{
  value: 'all',
  label: '全部'
}, {
  value: 'running',
  label: '运行中'
}, {
  value: 'stopped',
  label: '已停止'
}, {
  value: 'pending',
  label: '待登记'
}, {
  value: 'conflict',
  label: '冲突'
}];

/**
 * 本地项目页（第五阶段）：按 **项目目录** 聚合展示。
 *   - 已登记项目：项目卡片 + 子服务列表（同目录的多个进程/端口）
 *   - 未登记的项目组：一个卡片，可一次登记（只创建一个项目）
 *   - 未识别目录的独立服务：单独分组，不与任何项目合并
 */
export function ProjectsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const {
    data: projects,
    loading: projectsLoading,
    error: projectsError,
    reload: reloadProjects
  } = useAsync(() => api.projects(), {
    deps: []
  });
  const {
    data: grouping,
    loading: groupsLoading,
    error: groupsError,
    reload: reloadGroups
  } = useAsync(() => api.discoveryGroups(), {
    deps: []
  });
  // 第七阶段：登记项目 ↔ 远程服务器关联时要用服务器清单
  const {
    data: servers
  } = useAsync(() => api.servers(), {
    deps: []
  });
  const actions = useProjectActions(reloadProjects);
  const reload = useCallback(async () => {
    await Promise.all([reloadProjects(), reloadGroups()]);
  }, [reloadProjects, reloadGroups]);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [expanded, setExpanded] = useState({});
  // 「未识别目录的服务」默认折叠：这类候选在真实机器上常有几十个
  const [looseExpanded, setLooseExpanded] = useState(false);
  const [busy, setBusy] = useState({});
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [stopThenDeleting, setStopThenDeleting] = useState(false);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  // 启动失败诊断：projectId -> diagnosis。常驻到下次启动成功 / 停止 / 保存 / 手动收起
  const [failures, setFailures] = useState({});
  const clearFailure = useCallback(id => {
    setFailures(prev => {
      if (!prev[id]) return prev;
      const next = {
        ...prev
      };
      delete next[id];
      return next;
    });
  }, []);

  /**
   * 启动 / 重启的包装：actions 只负责弹 toast，这里把诊断结果接住——
   * 失败时写进 failures 让卡片显示横幅，成功时清掉旧横幅（上次的失败不该留着吓人）。
   */
  const handleStart = async project => {
    const data = await actions.start(project);
    const result = data?.result;
    if (!result) return;
    if (result.diagnosis) setFailures(prev => ({
      ...prev,
      [project.id]: result.diagnosis
    }));else clearFailure(project.id);
  };
  const handleRestart = async project => {
    const data = await actions.restart(project);
    const result = data?.result?.started;
    if (!result) return;
    if (result.diagnosis) setFailures(prev => ({
      ...prev,
      [project.id]: result.diagnosis
    }));else clearFailure(project.id);
  };
  const handleStop = async project => {
    await actions.stop(project);
    clearFailure(project.id);
  };
  useEffect(() => {
    const state = location.state;
    if (!state) return;
    if (state.create) {
      setEditing(null);
      setFormOpen(true);
    }
    if (state.edit && projects) {
      const target = projects.find(project => project.id === state.edit);
      if (target) {
        setEditing(target);
        setFormOpen(true);
      }
    }
    if (state.q) setQuery(state.q);
    if (state.discovery) setDiscoveryOpen(true);
    if (state.focus) {
      setExpanded(prev => ({
        ...prev,
        [state.focus]: true
      }));
      window.setTimeout(() => {
        document.querySelector(`[data-project-id="${state.focus}"]`)?.scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        });
      }, 260);
    }
    navigate(location.pathname, {
      replace: true,
      state: null
    });
  }, [location.state, location.pathname, navigate, projects]);
  usePolling(() => reload().catch(() => {}), 20000, autoRefresh);
  const projectById = useMemo(() => new Map((projects || []).map(project => [project.id, project])), [projects]);
  const groups = grouping?.groups || [];
  const loose = grouping?.loose || [];
  const systemServices = grouping?.system || [];
  const items = useMemo(() => groups.map(group => ({
    id: group.id,
    group,
    project: group.registeredProjectId ? projectById.get(group.registeredProjectId) || null : null
  })), [groups, projectById]);
  const counts = useMemo(() => ({
    all: items.length,
    running: items.filter(item => item.group.status === 'all-running').length,
    stopped: items.filter(item => item.group.status === 'all-stopped').length,
    pending: items.filter(item => item.group.registrationState !== 'registered').length,
    conflict: items.filter(item => item.group.status === 'conflict').length,
    registered: items.filter(item => item.group.registrationState === 'registered').length,
    subServices: groups.reduce((sum, group) => sum + (group.summary?.services || 0), 0)
  }), [items, groups]);
  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    return items.filter(item => {
      const group = item.group;
      if (filter === 'running' && group.status !== 'all-running') return false;
      if (filter === 'stopped' && group.status !== 'all-stopped') return false;
      if (filter === 'pending' && group.registrationState === 'registered') return false;
      if (filter === 'conflict' && group.status !== 'conflict') return false;
      if (!text) return true;
      return [group.name, group.projectDir, group.registeredProjectName, ...(group.summary?.portList || [])].filter(value => value !== null && value !== undefined).some(value => String(value).toLowerCase().includes(text));
    });
  }, [items, filter, query]);
  async function withBusy(key, fn, messages) {
    setBusy(prev => ({
      ...prev,
      [key]: true
    }));
    try {
      const data = await fn();
      if (messages?.success) toast.success(messages.success, data?.project?.name || messages.detail);
      await reload();
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
  const registerGroup = group => withBusy(`grp:${group.id}`, () => api.discoveryRegisterGroup(group.id), {
    success: `已登记（合并 ${group.summary.live} 个服务）`,
    error: '登记项目组失败'
  });
  const ignoreGroupServices = group => withBusy(`grpign:${group.id}`, async () => {
    const fingerprints = group.services.filter(service => service.live && service.key).map(service => service.key);
    return api.discoveryIgnore(fingerprints, '整组忽略');
  }, {
    success: '已忽略该目录下的服务（后续扫描不再提示）',
    error: '忽略失败'
  });
  const associateService = (service, projectId) => withBusy(`assoc:${service.key}`, () => api.discoveryAssociate(service.key, projectId), {
    success: '已关联为子服务',
    error: '关联失败'
  });
  const ignoreService = service => withBusy(`ign:${service.key}`, () => api.discoveryIgnore([service.key], '子服务忽略'), {
    success: '已忽略这个子服务',
    error: '忽略失败'
  });
  const dissociateService = service => withBusy(`dissoc:${service.id}`, () => api.discoveryDissociate(service.registeredProjectId, service.id), {
    success: '已解除子服务关联',
    error: '解除失败'
  });
  const registerSingle = service => withBusy(`reg:${service.key}`, () => api.discoveryRegister(service.key), {
    success: '已登记为独立项目',
    error: '登记失败'
  });

  // ---- 第七阶段：项目 ↔ 远程服务器的显式关联（端口对不上时的兜底） ----
  const [linkPicker, setLinkPicker] = useState(null); // { projectId, groupId, candidates: [...] }

  const openLinkPicker = group => {
    const projectId = group.registeredProjectId;
    if (!projectId) return;
    // 候选 = 所有服务器（去掉已经关联过的），供用户挑一个
    const linked = new Set((group.project?.remoteLinks || []).map(link => link.serverId));
    const candidates = (servers || []).filter(item => !linked.has(item.id));
    if (candidates.length === 0) {
      toast.warn('没有可关联的服务器', '所有服务器都已关联到该项目');
      return;
    }
    setLinkPicker({
      projectId,
      groupId: group.id,
      candidates
    });
  };
  const confirmLink = async serverId => {
    if (!linkPicker) return;
    await withBusy(`link:${linkPicker.projectId}:${serverId}`, () => api.discoveryProjectLink(linkPicker.projectId, serverId), {
      success: '已登记项目与服务器的关联',
      error: '关联失败'
    });
    setLinkPicker(null);
  };
  const unlinkServer = async group => {
    const link = (group.project?.remoteLinks || [])[0];
    if (!link) return;
    await withBusy(`unlink:${group.id}`, () => api.discoveryProjectLink(link.projectId || group.registeredProjectId, link.serverId, {
      remove: true
    }), {
      success: '已取消手工关联',
      error: '取消失败'
    });
  };
  async function handleSubmit(payload) {
    setSubmitting(true);
    try {
      if (editing?.id) {
        await api.updateProject(editing.id, payload);
        clearFailure(editing.id);
        toast.success('项目已更新', payload.name);
      } else {
        await api.createProject(payload);
        toast.success('项目已新增', payload.name);
      }
      setFormOpen(false);
      setEditing(null);
      await reload();
    } catch (err) {
      toast.error('保存失败', err.message);
    } finally {
      setSubmitting(false);
    }
  }
  async function handleDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteProject(pendingDelete.id);
      toast.success('项目记录已删除', pendingDelete.name);
      setPendingDelete(null);
      await reload();
    } catch (err) {
      toast.error('删除失败', err.message);
    } finally {
      setDeleting(false);
    }
  }

  /**
   * 「先停止，再删除」：删运行中的项目只会删记录、留下占端口的孤儿进程，
   * 新手十有八九会踩这个坑（之后同端口全报冲突）——给一条不用先想明白的稳妥路径。
   */
  async function handleStopThenDelete() {
    if (!pendingDelete) return;
    setStopThenDeleting(true);
    try {
      await actions.stop(pendingDelete);
      await api.deleteProject(pendingDelete.id);
      clearFailure(pendingDelete.id);
      toast.success('已停止并删除', pendingDelete.name);
      setPendingDelete(null);
      await reload();
    } catch (err) {
      toast.error('操作失败', err.message);
    } finally {
      setStopThenDeleting(false);
    }
  }
  const error = projectsError || groupsError;
  return /*#__PURE__*/_jsxs("div", {
    className: "page",
    children: [/*#__PURE__*/_jsxs("div", {
      className: "page__header",
      children: [/*#__PURE__*/_jsx("div", {
        className: "page__title",
        children: "\u672C\u5730\u9879\u76EE"
      }), /*#__PURE__*/_jsxs("div", {
        className: "page__actions",
        children: [/*#__PURE__*/_jsx(Switch, {
          checked: autoRefresh,
          onChange: setAutoRefresh,
          label: "\u81EA\u52A8\u5237\u65B0"
        }), /*#__PURE__*/_jsx(Button, {
          icon: "refresh",
          loading: projectsLoading || groupsLoading,
          onClick: () => reload().catch(() => {}),
          children: "\u5237\u65B0"
        }), /*#__PURE__*/_jsx(Button, {
          icon: "search",
          onClick: () => setDiscoveryOpen(prev => !prev),
          children: "\u81EA\u52A8\u53D1\u73B0"
        }), /*#__PURE__*/_jsx(Button, {
          variant: "primary",
          icon: "plus",
          onClick: () => {
            setEditing(null);
            setFormOpen(true);
          },
          children: "\u65B0\u589E\u9879\u76EE"
        })]
      })]
    }), /*#__PURE__*/_jsx(PageHint, {
      id: "projects",
      icon: "folder",
      action: {
        label: '自动发现',
        onClick: () => setDiscoveryOpen(true)
      },
      children: "\u628A\u672C\u673A\u9879\u76EE\u767B\u8BB0\u8FDB\u6765\uFF0C\u5C31\u80FD\u4E00\u952E\u542F\u505C\u3001\u770B\u7AEF\u53E3\u548C\u65E5\u5FD7\u3002\u4E0D\u77E5\u9053\u6709\u54EA\u4E9B\u5728\u8DD1\uFF1F\u70B9\u300C\u81EA\u52A8\u53D1\u73B0\u300D\u626B\u63CF\u76D1\u542C\u7AEF\u53E3\uFF0C\u6309\u76EE\u5F55\u81EA\u52A8\u805A\u6210\u9879\u76EE\u7EC4\u3002"
    }), discoveryOpen ? /*#__PURE__*/_jsx(DiscoveryPanel, {
      onClose: () => setDiscoveryOpen(false),
      onRegistered: reload
    }) : null, /*#__PURE__*/_jsxs("div", {
      className: "toolbar",
      children: [/*#__PURE__*/_jsx(Tabs, {
        value: filter,
        onChange: setFilter,
        options: FILTERS.map(item => ({
          ...item,
          count: counts[item.value]
        })).filter(
        // 降噪：0 条的筛选不占位置；但正选中它时要保留，否则无法切回「全部」
        item => item.value === 'all' || item.count > 0 || item.value === filter)
      }), /*#__PURE__*/_jsx(SearchBox, {
        value: query,
        onChange: setQuery,
        placeholder: "\u6309\u9879\u76EE\u540D / \u76EE\u5F55 / \u7AEF\u53E3\u7B5B\u9009\u2026",
        width: 260
      }), /*#__PURE__*/_jsx("div", {
        className: "spacer"
      }), /*#__PURE__*/_jsxs("span", {
        className: "footnote",
        children: ["\u9879\u76EE\u7EC4 ", counts.all, " \xB7 \u5DF2\u767B\u8BB0 ", counts.registered, " \xB7 \u5F85\u767B\u8BB0 ", counts.pending, " \xB7 \u5B50\u670D\u52A1 ", counts.subServices]
      })]
    }), error ? /*#__PURE__*/_jsx(ErrorNotice, {
      error: error,
      onRetry: () => reload().catch(() => {})
    }) : null, systemServices.length > 0 ? /*#__PURE__*/_jsxs("div", {
      className: "inline-hint",
      children: [/*#__PURE__*/_jsx(Icon, {
        name: "shield",
        size: 13
      }), /*#__PURE__*/_jsxs("span", {
        children: ["\u53E6\u6709 ", systemServices.length, " \u4E2A\u7CFB\u7EDF\u8FDB\u7A0B\u5728\u76D1\u542C\uFF08\u5DF2\u81EA\u52A8\u8FC7\u6EE4\uFF0C\u4E0D\u8BA1\u5165\u9879\u76EE\uFF09"]
      })]
    }) : null, !grouping ? /*#__PURE__*/_jsx("div", {
      className: "card",
      children: /*#__PURE__*/_jsx(SkeletonList, {
        rows: 4
      })
    }) : /*#__PURE__*/_jsxs(_Fragment, {
      children: [/*#__PURE__*/_jsxs("div", {
        className: "stack",
        children: [filtered.length === 0 ? /*#__PURE__*/_jsx("div", {
          className: "card card--empty",
          children: /*#__PURE__*/_jsx(EmptyState, {
            title: items.length === 0 ? '还没有项目' : '没有匹配的项目',
            hint: items.length === 0 ? '把本机在跑的项目登记进来，之后就能一键启动 / 停止、看端口占用和日志。' : '换个关键字或筛选条件试试。',
            action: items.length === 0 ? /*#__PURE__*/_jsxs("div", {
              className: "row",
              style: {
                gap: 8,
                justifyContent: 'center'
              },
              children: [/*#__PURE__*/_jsx(Button, {
                variant: "primary",
                icon: "search",
                onClick: () => setDiscoveryOpen(true),
                children: "\u81EA\u52A8\u53D1\u73B0\u672C\u673A\u670D\u52A1"
              }), /*#__PURE__*/_jsx(Button, {
                icon: "plus",
                onClick: () => {
                  setEditing(null);
                  setFormOpen(true);
                },
                children: "\u624B\u52A8\u65B0\u589E"
              })]
            }) : null
          })
        }) : null, filtered.map(item => {
          const group = item.group;
          if (item.project) {
            const isOpen = Boolean(expanded[group.id]);
            return /*#__PURE__*/_jsxs("div", {
              "data-project-id": item.project.id,
              className: "group-card",
              children: [/*#__PURE__*/_jsx(ProjectCard, {
                project: item.project,
                action: actions.actionOf(item.project.id),
                onStart: handleStart,
                onStop: handleStop,
                onRestart: handleRestart,
                onOpenDir: actions.openDir,
                onOpenUrl: actions.openUrl,
                onCopyUrl: actions.copyUrl,
                onLog: project => navigate('/logs', {
                  state: {
                    source: `project:${project.id}`
                  }
                }),
                onNavigate: target => navigate(target.to, {
                  state: target.state
                }),
                failure: failures[item.project.id] || null,
                onDismissFailure: clearFailure,
                onEdit: project => {
                  setEditing(project);
                  setFormOpen(true);
                },
                onDelete: setPendingDelete,
                serviceSummary: group.summary,
                groupStatus: {
                  status: group.status,
                  tone: group.statusTone
                },
                expanded: isOpen,
                onToggleExpand: () => setExpanded(prev => ({
                  ...prev,
                  [group.id]: !prev[group.id]
                }))
              }), isOpen ? /*#__PURE__*/_jsxs("div", {
                className: "group-card__body",
                children: [group.conflicts?.length ? /*#__PURE__*/_jsx(Notice, {
                  tone: "error",
                  icon: "alert",
                  children: group.conflicts.map(conflict => /*#__PURE__*/_jsx("div", {
                    children: conflict.message
                  }, `${conflict.port}-${conflict.type}`))
                }) : null, /*#__PURE__*/_jsx(ServiceList, {
                  services: group.services,
                  busy: busy,
                  onAssociate: service => associateService(service, item.project.id),
                  onIgnore: ignoreService,
                  onDissociate: dissociateService,
                  onRegisterSingle: registerSingle,
                  onEditRegister: () => setDiscoveryOpen(true),
                  emptyText: "\u8FD9\u4E2A\u9879\u76EE\u4E0B\u7684\u670D\u52A1\u5F53\u524D\u90FD\u6CA1\u6709\u5728\u76D1\u542C\u3002"
                }), /*#__PURE__*/_jsx(ProjectResources, {
                  resources: group.resources,
                  loading: groupsLoading,
                  onLinkServer: () => openLinkPicker(group),
                  onUnlink: () => unlinkServer(group)
                }), /*#__PURE__*/_jsx(ProjectTimeline, {
                  projectId: item.project.id
                })]
              }) : null]
            }, group.id);
          }
          return /*#__PURE__*/_jsx(ProjectGroupCard, {
            group: group,
            expanded: Boolean(expanded[group.id]),
            onToggle: () => setExpanded(prev => ({
              ...prev,
              [group.id]: !prev[group.id]
            })),
            busy: busy,
            onRegisterGroup: registerGroup,
            onIgnoreGroup: ignoreGroupServices,
            onRegisterSingle: registerSingle,
            onEditRegister: () => setDiscoveryOpen(true),
            onIgnoreService: ignoreService
          }, group.id);
        })]
      }), loose.length > 0 ? /*#__PURE__*/_jsxs("div", {
        className: "card",
        style: {
          marginTop: 16
        },
        children: [/*#__PURE__*/_jsxs("header", {
          className: "card__header",
          children: [/*#__PURE__*/_jsx("div", {
            className: "card__title",
            children: /*#__PURE__*/_jsxs("button", {
              type: "button",
              className: "card__toggle",
              "aria-expanded": looseExpanded,
              onClick: () => setLooseExpanded(prev => !prev),
              children: [/*#__PURE__*/_jsx(Icon, {
                name: looseExpanded ? 'chevronDown' : 'chevronRight',
                size: 13
              }), "\u672A\u8BC6\u522B\u76EE\u5F55\u7684\u670D\u52A1"]
            })
          }), /*#__PURE__*/_jsxs("div", {
            className: "card__actions",
            children: [/*#__PURE__*/_jsxs("span", {
              className: "status-word muted",
              children: [loose.length, " \u7EC4 \xB7 ", loose.reduce((sum, group) => sum + group.services.length, 0), " \u4E2A\u670D\u52A1"]
            }), /*#__PURE__*/_jsx(Button, {
              size: "sm",
              icon: "search",
              onClick: () => setDiscoveryOpen(true),
              children: "\u53BB\u767B\u8BB0"
            })]
          })]
        }), looseExpanded ? /*#__PURE__*/_jsx("div", {
          className: "card__body",
          children: loose.map(group => /*#__PURE__*/_jsxs("div", {
            style: {
              marginBottom: 12
            },
            children: [/*#__PURE__*/_jsxs("div", {
              className: "row",
              style: {
                gap: 8,
                marginBottom: 4
              },
              children: [/*#__PURE__*/_jsx("span", {
                className: "group-card__name",
                children: group.name
              }), /*#__PURE__*/_jsxs("span", {
                className: "tech muted",
                children: [group.summary.portList.join(' ') || '—', " \xB7 ", group.summary.processes, " \u8FDB\u7A0B"]
              })]
            }), /*#__PURE__*/_jsx(ServiceList, {
              services: group.services,
              busy: busy,
              onIgnore: ignoreService,
              onRegisterSingle: registerSingle,
              onEditRegister: () => setDiscoveryOpen(true),
              compact: true
            })]
          }, group.id))
        }) : null]
      }) : null, filtered.length > 0 && filtered.length <= 2 ? /*#__PURE__*/_jsxs("div", {
        className: "card onboarding",
        children: [/*#__PURE__*/_jsxs("div", {
          className: "card__title",
          children: [/*#__PURE__*/_jsx(Icon, {
            name: "layers",
            size: 15,
            style: {
              color: 'var(--accent)'
            }
          }), "\u8FD8\u80FD\u505A\u8FD9\u4E9B"]
        }), /*#__PURE__*/_jsxs("div", {
          className: "onboarding__grid",
          children: [/*#__PURE__*/_jsxs("button", {
            type: "button",
            className: "onboarding__item",
            onClick: () => setDiscoveryOpen(true),
            children: [/*#__PURE__*/_jsx(Icon, {
              name: "search",
              size: 16
            }), /*#__PURE__*/_jsx("span", {
              className: "onboarding__title",
              children: "\u81EA\u52A8\u53D1\u73B0\u672C\u673A\u670D\u52A1"
            }), /*#__PURE__*/_jsx("span", {
              className: "onboarding__desc",
              children: "\u626B\u63CF\u76D1\u542C\u7AEF\u53E3\uFF0C\u6309\u76EE\u5F55\u805A\u5408\u6210\u9879\u76EE\u7EC4\uFF0C\u4E0D\u7528\u4E00\u4E2A\u4E2A\u624B\u586B"
            })]
          }), /*#__PURE__*/_jsxs("button", {
            type: "button",
            className: "onboarding__item",
            onClick: () => {
              setEditing(null);
              setFormOpen(true);
            },
            children: [/*#__PURE__*/_jsx(Icon, {
              name: "plus",
              size: 16
            }), /*#__PURE__*/_jsx("span", {
              className: "onboarding__title",
              children: "\u624B\u52A8\u65B0\u589E\u9879\u76EE"
            }), /*#__PURE__*/_jsx("span", {
              className: "onboarding__desc",
              children: "\u5DF2\u77E5\u76EE\u5F55\u548C\u542F\u52A8\u547D\u4EE4\u65F6\uFF0C\u76F4\u63A5\u767B\u8BB0\u5E76\u4E00\u952E\u542F\u505C"
            })]
          }), /*#__PURE__*/_jsxs("button", {
            type: "button",
            className: "onboarding__item",
            onClick: () => navigate('/ports'),
            children: [/*#__PURE__*/_jsx(Icon, {
              name: "ports",
              size: 16
            }), /*#__PURE__*/_jsx("span", {
              className: "onboarding__title",
              children: "\u67E5\u770B\u7AEF\u53E3\u5360\u7528"
            }), /*#__PURE__*/_jsx("span", {
              className: "onboarding__desc",
              children: "\u54EA\u4E9B\u7AEF\u53E3\u88AB\u8C01\u5360\u4E86\uFF0C\u4E00\u773C\u770B\u6E05\uFF0C\u907F\u514D\u542F\u52A8\u65F6\u649E\u7AEF\u53E3"
            })]
          })]
        })]
      }) : null]
    }), /*#__PURE__*/_jsx(ProjectFormModal, {
      open: formOpen,
      initial: editing,
      submitting: submitting,
      onClose: () => {
        setFormOpen(false);
        setEditing(null);
      },
      onSubmit: handleSubmit
    }), /*#__PURE__*/_jsx(ConfirmDialog, {
      open: Boolean(pendingDelete),
      title: `删除项目「${pendingDelete?.name || ''}」`,
      message: pendingDelete && (pendingDelete.status === 'running' || pendingDelete.status === 'starting') ? `这个项目正在运行${pendingDelete.port ? `（端口 ${pendingDelete.port}）` : ''}。删除只移除工作台里的记录，不会结束进程——端口会继续被占用，之后同端口的项目会一直报冲突。建议先停止再删除。` : '只会删除工作台里的记录（含其子服务关联），不会删除磁盘上的项目文件，也不会结束正在运行的进程。',
      loading: deleting || stopThenDeleting,
      secondary: pendingDelete && (pendingDelete.status === 'running' || pendingDelete.status === 'starting') ? {
        label: '先停止，再删除',
        onClick: handleStopThenDelete,
        loading: stopThenDeleting
      } : null,
      onClose: () => setPendingDelete(null),
      onConfirm: handleDelete
    }), linkPicker ? /*#__PURE__*/_jsxs(Modal, {
      open: true,
      title: "\u767B\u8BB0\u9879\u76EE\u4E0E\u670D\u52A1\u5668\u7684\u5173\u8054",
      onClose: () => setLinkPicker(null),
      children: [/*#__PURE__*/_jsx("p", {
        className: "footnote",
        style: {
          marginBottom: 10
        },
        children: "\u81EA\u52A8\u5173\u8054\u53EA\u8BA4\u7AEF\u53E3\u3002\u5982\u679C\u8FD9\u53F0\u673A\u5668\u4E0A\u7684\u670D\u52A1\u548C\u672C\u9879\u76EE\u786E\u5B9E\u76F8\u5173\uFF0C\u4F46\u7AEF\u53E3\u6CA1\u5BF9\u4E0A\uFF0C\u53EF\u4EE5\u5728\u8FD9\u91CC\u624B\u5DE5\u767B\u8BB0\u4E00\u6761\u5173\u8054\uFF08\u8BB0\u5F55\u4E0B\u6765\u7684\u662F\u4F60\u786E\u8BA4\u8FC7\u7684\u5173\u7CFB\uFF0C\u4E0D\u662F\u6309\u540D\u5B57\u731C\uFF09\u3002"
      }), /*#__PURE__*/_jsx("div", {
        className: "stack",
        children: linkPicker.candidates.map(server => /*#__PURE__*/_jsxs("div", {
          className: "res-link-row",
          children: [/*#__PURE__*/_jsxs("div", {
            style: {
              minWidth: 0,
              flex: 1
            },
            children: [/*#__PURE__*/_jsxs("div", {
              className: "row",
              style: {
                gap: 6
              },
              children: [/*#__PURE__*/_jsx("span", {
                className: "res-name",
                children: server.name
              }), /*#__PURE__*/_jsx("span", {
                className: "tech muted",
                children: server.host
              }), server.ssh?.ok ? /*#__PURE__*/_jsx("span", {
                className: "status-word",
                children: "\u5728\u7EBF"
              }) : /*#__PURE__*/_jsx("span", {
                className: "status-word muted",
                children: "\u672A\u91C7\u96C6"
              })]
            }), server.metrics?.cpuUsagePercent !== undefined && server.metrics?.cpuUsagePercent !== null ? /*#__PURE__*/_jsxs("div", {
              className: "footnote",
              children: ["\u6574\u673A CPU ", server.metrics.cpuUsagePercent, "%"]
            }) : /*#__PURE__*/_jsx("div", {
              className: "footnote",
              children: "\u8FD8\u6CA1\u6709\u91C7\u96C6\u8FC7\u8FD9\u53F0\u673A\u5668\u7684\u8D44\u6E90"
            })]
          }), /*#__PURE__*/_jsx(Button, {
            size: "sm",
            icon: "link",
            onClick: () => confirmLink(server.id),
            children: "\u5173\u8054"
          })]
        }, server.id))
      })]
    }) : null]
  });
}