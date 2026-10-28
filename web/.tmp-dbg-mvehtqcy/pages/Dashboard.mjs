import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAsync, usePolling } from '../hooks/useAsync.js';
import { useProjectActions } from '../hooks/useProjectActions.js';
import { useServerActions } from '../hooks/useServerActions.js';
import { ProjectCard } from '../components/ProjectCard.mjs';
import { EventTimeline } from '../components/EventTimeline.mjs';
import { OnboardingCard } from '../components/OnboardingCard.mjs';
import { PageHint } from '../components/PageHint.mjs';
import { PreflightCard } from '../components/PreflightCard.mjs';
import { Icon } from '../components/Icons.mjs';
import { Button, Card, EmptyState, ErrorNotice, SkeletonList, Switch } from '../components/ui.mjs';
import { timeAgo } from '../utils/format.js';

/**
 * 总览：只回答"现在怎么样、有没有异常"。
 * 顶部四个核心状态 + 当前运行项目 + 最近活动，其余细节都在各自页面。
 */
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function DashboardPage() {
  const navigate = useNavigate();
  const {
    data,
    loading,
    error,
    reload
  } = useAsync(() => api.dashboard(true), {
    deps: []
  });
  // 环境体检：后端 30 秒缓存，跟随总览同一节奏轮询；缺必需组件时「待处理」里要有一条
  const {
    data: preflight,
    reload: reloadPreflight
  } = useAsync(() => api.preflight(false), {
    deps: []
  });
  const [autoRefresh, setAutoRefresh] = useState(true);
  const probedRef = useRef(false);
  const actions = useProjectActions(reload);
  const servers = useServerActions(reload);

  // 首屏渲染后异步做一次"过期即采集"的 SSH 检测，不阻塞页面
  useEffect(() => {
    if (probedRef.current || !data) return;
    probedRef.current = true;
    api.sshProbeAll(false, 60000).then(result => {
      if (result?.probed > 0) reload().catch(() => {});
    }).catch(() => {});
  }, [data, reload]);
  usePolling(() => reload().catch(() => {}), 20000, autoRefresh);
  usePolling(() => reloadPreflight().catch(() => {}), 20000, autoRefresh);
  const projects = data?.projects || [];
  const stats = data?.stats;
  const docker = data?.docker;
  const timeline = data?.timeline || [];
  const discovery = data?.discovery;
  const lastMonitorAt = (data?.servers || []).map(server => server.monitor?.at).filter(Boolean).sort().pop();
  const runningProjects = projects.filter(project => project.status === 'running' || project.status === 'starting');
  const conflictCount = stats?.conflicts?.value ?? projects.filter(project => project.status === 'conflict').length;
  // 环境体检里「必需但没就绪」的项：缺 Python 网盘功能就废了，必须进待处理
  const preflightMissing = (preflight?.items || []).filter(item => !item.ok && item.required);
  const anomalyCount = projects.filter(project => !project.dirExists).length + (docker?.unhealthy ?? 0) + preflightMissing.length;
  const openLog = useCallback(project => navigate('/logs', {
    state: {
      source: `project:${project.id}`
    }
  }), [navigate]);

  /** 环境问题没有专属页面，点击「去处理」就是把体检卡滚出来并展开（缺必需项时它本就自动展开） */
  const scrollToPreflight = useCallback(() => {
    document.getElementById('preflight-card')?.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
  }, []);
  async function dismissDiscoveryNotice() {
    try {
      await api.discoveryAcknowledge((discovery?.newCandidates || []).map(item => item.fingerprint));
      await reload();
    } catch (err) {
      console.warn('标记已读失败', err);
    }
  }
  const missingDirs = projects.filter(project => !project.dirExists).length;
  const serversOnline = stats?.serversOnline.value ?? 0;
  const states = [{
    label: '运行中项目',
    value: stats?.localRunning.value ?? runningProjects.length,
    total: stats?.localRunning.total,
    route: '/projects',
    dot: runningProjects.length > 0 ? 'running' : 'stopped'
  }, {
    label: '待处理',
    value: anomalyCount,
    route: '/projects',
    alert: anomalyCount > 0,
    dot: anomalyCount > 0 ? 'conflict' : 'stopped',
    title: `目录不存在 ${missingDirs} · 异常容器 ${docker?.unhealthy ?? 0} · 环境组件缺失 ${preflightMissing.length}`,
    // 环境问题占大头时，点击应直接把体检卡滚出来，而不是跳去无关的「本地项目」
    onClick: preflightMissing.length > 0 ? scrollToPreflight : undefined
  }, {
    label: '在线服务器',
    value: serversOnline,
    total: stats?.serversOnline.total,
    route: '/servers',
    dot: serversOnline > 0 ? 'running' : 'stopped'
  }, {
    label: '端口冲突',
    value: conflictCount,
    route: '/ports',
    alert: conflictCount > 0,
    dot: conflictCount > 0 ? 'conflict' : 'stopped'
  }];

  // 「一目了然」：有异常时异常项排最前，正常状态垫后 —— 一眼先看到"哪里不对"
  const orderedStates = [...states].sort((a, b) => (b.alert ? 1 : 0) - (a.alert ? 1 : 0));

  // 端口冲突里如果混着"疑似重复登记"，要分开说：前者是故障，后者只是登记冗余
  const portConflicts = data?.conflicts || [];
  const hasDuplicateRegistration = portConflicts.some(item => item.type === 'duplicate-registration');

  // 待处理清单：只列真正需要用户动手的，每条都能一键跳到能解决它的地方
  // 「未登记服务」也归入这里，不再单独挂一条横幅 —— 同一件事不该让人处理两遍
  const discoveryNames = (discovery?.newCandidates || []).slice(0, 3).map(item => item.processName ? `${item.processName}:${item.port}` : item.serviceName || `:${item.port}`);
  const discoveryDetail = discoveryNames.length > 0 ? ` · ${discoveryNames.join('、')}${discovery.newCount > 3 ? ` 等 ${discovery.newCount} 个` : ''}` : '';
  const todos = [
  // 环境缺失排最前：它是"别的功能为什么用不了"的根因，比项目级异常更优先
  ...preflightMissing.map(item => ({
    id: `preflight-${item.id}`,
    level: 'error',
    text: `${item.label} 没就绪：${item.why}`,
    go: scrollToPreflight
  })), ...(discovery?.newCount > 0 ? [{
    id: 'discovery',
    level: 'warn',
    text: `${discovery.newCount} 个本机监听服务还没登记${discoveryDetail}`,
    go: () => navigate('/projects', {
      state: {
        discovery: true
      }
    })
  }] : []), ...(missingDirs > 0 ? [{
    id: 'missing-dirs',
    level: 'warn',
    text: `${missingDirs} 个项目的目录不存在（可能磁盘没挂载或路径改了）`,
    go: () => navigate('/projects')
  }] : []), ...(conflictCount > 0 ? [{
    id: 'port-conflict',
    // 「疑似重复登记」不是故障（同一个服务被登记了两次而已），不该用红色高危语气
    level: hasDuplicateRegistration ? 'warn' : 'error',
    text: hasDuplicateRegistration ? `${conflictCount} 个端口被重复登记（父子目录的项目声明了同一个端口）` : `${conflictCount} 个端口冲突，服务可能起不来`,
    go: () => navigate('/ports')
  }] : []), ...(docker?.unhealthy > 0 ? [{
    id: 'docker',
    level: 'error',
    text: `${docker.unhealthy} 个容器健康检查异常`,
    go: () => navigate('/servers')
  }] : [])];

  // 首屏整体加载态：dashboard 一次要跑端口扫描 + 项目状态 + 服务器列表，实测约 3-5 秒。
  // 期间若什么都不渲染，用户看到的就是"黑屏"（外壳在、内容区空着）。
  // 这里明确告知正在做什么，比空白更可信。
  const firstLoad = loading && !data;
  return /*#__PURE__*/_jsxs("div", {
    className: "page",
    children: [/*#__PURE__*/_jsxs("div", {
      className: "page__header",
      children: [/*#__PURE__*/_jsx("div", {
        className: "page__title",
        children: "\u603B\u89C8"
      }), /*#__PURE__*/_jsxs("div", {
        className: "page__actions",
        children: [/*#__PURE__*/_jsx(Switch, {
          checked: autoRefresh,
          onChange: setAutoRefresh,
          label: "\u81EA\u52A8\u5237\u65B0"
        }), /*#__PURE__*/_jsx(Button, {
          icon: "refresh",
          loading: loading,
          onClick: () => reload().catch(() => {}),
          children: "\u5237\u65B0"
        }), /*#__PURE__*/_jsx(Button, {
          variant: "primary",
          icon: "wifi",
          loading: servers.isBusy('all:ssh'),
          onClick: servers.sshProbeAll,
          children: "SSH \u68C0\u6D4B"
        })]
      })]
    }), /*#__PURE__*/_jsx(PageHint, {
      id: "dashboard",
      icon: "dashboard",
      children: "\u8FD9\u9875\u56DE\u7B54\u300C\u73B0\u5728\u600E\u4E48\u6837\u300D\uFF1A\u54EA\u4E9B\u9879\u76EE\u5728\u8DD1\u3001\u6709\u6CA1\u6709\u8981\u5904\u7406\u7684\u4E8B\u3002\u51FA\u73B0\u5F02\u5E38\u65F6\u5148\u770B\u300C\u5F85\u5904\u7406\u300D\uFF0C\u6BCF\u6761\u90FD\u80FD\u4E00\u952E\u8DF3\u5230\u80FD\u89E3\u51B3\u5B83\u7684\u9875\u9762\u3002"
    }), error ? /*#__PURE__*/_jsx(ErrorNotice, {
      error: error,
      onRetry: () => reload().catch(() => {})
    }) : null, firstLoad ? /*#__PURE__*/_jsx(Card, {
      children: /*#__PURE__*/_jsxs("div", {
        className: "boot-hint",
        children: [/*#__PURE__*/_jsx("span", {
          className: "spinner"
        }), /*#__PURE__*/_jsxs("div", {
          children: [/*#__PURE__*/_jsx("div", {
            className: "boot-hint__title",
            children: "\u6B63\u5728\u8BFB\u53D6\u672C\u673A\u72B6\u6001\u2026"
          }), /*#__PURE__*/_jsx("div", {
            className: "boot-hint__desc",
            children: "\u9700\u8981\u626B\u63CF\u76D1\u542C\u7AEF\u53E3\u3001\u6838\u5BF9\u9879\u76EE\u8FD0\u884C\u72B6\u6001\uFF0C\u901A\u5E38 3 \u5230 5 \u79D2"
          })]
        })]
      })
    }) : null, !firstLoad && !error ? /*#__PURE__*/_jsx(OnboardingCard, {
      projects: projects,
      onGo: (path, state) => navigate(path, {
        state
      })
    }) : null, !firstLoad && !error ? /*#__PURE__*/_jsx("div", {
      id: "preflight-card",
      children: /*#__PURE__*/_jsx(PreflightCard, {})
    }) : null, /*#__PURE__*/_jsxs("div", {
      className: "status-strip",
      children: [orderedStates.map(item => /*#__PURE__*/_jsxs("button", {
        type: "button",
        className: `status-strip__item ${item.alert ? 'is-alert' : ''}`,
        title: item.title,
        onClick: item.onClick ?? (() => navigate(item.route)),
        children: [/*#__PURE__*/_jsx("span", {
          className: `status-dot status-dot--${item.dot}`
        }), /*#__PURE__*/_jsx("span", {
          className: "status-strip__label",
          children: item.label
        }), /*#__PURE__*/_jsxs("span", {
          className: "status-strip__value",
          children: [item.value, item.total !== undefined && item.total !== null ? /*#__PURE__*/_jsxs("small", {
            children: ["/", item.total]
          }) : null]
        })]
      }, item.label)), lastMonitorAt ? /*#__PURE__*/_jsxs("span", {
        className: "status-strip__note",
        children: ["SSH \u91C7\u96C6 ", timeAgo(lastMonitorAt)]
      }) : null]
    }), todos.length > 0 ? /*#__PURE__*/_jsxs("div", {
      className: "card todos",
      children: [/*#__PURE__*/_jsxs("div", {
        className: "card__title",
        children: [/*#__PURE__*/_jsx(Icon, {
          name: "alert",
          size: 15,
          style: {
            color: 'var(--amber)'
          }
        }), "\u5F85\u5904\u7406", /*#__PURE__*/_jsxs("span", {
          className: "card__title-sub",
          children: [todos.length, " \u9879"]
        })]
      }), discovery?.newCount > 0 ? /*#__PURE__*/_jsx("div", {
        className: "todos__dismiss",
        children: /*#__PURE__*/_jsx(Button, {
          size: "sm",
          icon: "check",
          onClick: dismissDiscoveryNotice,
          children: "\u77E5\u9053\u4E86"
        })
      }) : null, /*#__PURE__*/_jsx("div", {
        className: "todos__list",
        children: todos.map(todo => /*#__PURE__*/_jsxs("button", {
          type: "button",
          className: "todo",
          onClick: todo.go,
          children: [/*#__PURE__*/_jsx("span", {
            className: `todo__dot todo__dot--${todo.level}`
          }), /*#__PURE__*/_jsx("span", {
            className: "todo__text",
            children: todo.text
          }), /*#__PURE__*/_jsxs("span", {
            className: "todo__go",
            children: ["\u53BB\u5904\u7406", /*#__PURE__*/_jsx(Icon, {
              name: "chevronRight",
              size: 12
            })]
          })]
        }, todo.id))
      })]
    }) : null, /*#__PURE__*/_jsxs("div", {
      className: "grid grid--main",
      children: [/*#__PURE__*/_jsx(Card, {
        title: "\u5F53\u524D\u8FD0\u884C\u9879\u76EE",
        subtitle: String(runningProjects.length),
        icon: "play",
        flush: true,
        actions: /*#__PURE__*/_jsx(Button, {
          size: "sm",
          icon: "external",
          onClick: () => navigate('/projects'),
          children: "\u672C\u5730\u9879\u76EE"
        }),
        children: loading && !data ? /*#__PURE__*/_jsx(SkeletonList, {
          rows: 3
        }) : runningProjects.length === 0 ? /*#__PURE__*/_jsx(EmptyState, {
          title: "\u6CA1\u6709\u6B63\u5728\u8FD0\u884C\u7684\u9879\u76EE",
          hint: projects.length === 0 ? '还没有登记项目，先去自动发现本机服务，或手动新增一个。' : '项目都在，去「本地项目」点启动。',
          action: projects.length === 0 ? /*#__PURE__*/_jsx(Button, {
            variant: "primary",
            icon: "search",
            onClick: () => navigate('/projects', {
              state: {
                discovery: true
              }
            }),
            children: "\u81EA\u52A8\u53D1\u73B0\u672C\u673A\u670D\u52A1"
          }) : /*#__PURE__*/_jsx(Button, {
            icon: "external",
            onClick: () => navigate('/projects'),
            children: "\u53BB\u672C\u5730\u9879\u76EE"
          })
        }) : runningProjects.map(project => /*#__PURE__*/_jsx(ProjectCard, {
          project: project,
          action: actions.actionOf(project.id),
          onStart: actions.start,
          onStop: actions.stop,
          onRestart: actions.restart,
          onOpenDir: actions.openDir,
          onOpenUrl: actions.openUrl,
          onCopyUrl: actions.copyUrl,
          onLog: openLog,
          onEdit: () => navigate('/projects', {
            state: {
              edit: project.id
            }
          }),
          onDelete: () => navigate('/projects', {
            state: {
              focus: project.id
            }
          })
        }, project.id))
      }), /*#__PURE__*/_jsx(Card, {
        title: "\u6700\u8FD1\u6D3B\u52A8",
        icon: "clock",
        flush: true,
        actions: /*#__PURE__*/_jsx(Button, {
          size: "sm",
          icon: "external",
          onClick: () => navigate('/timeline'),
          children: "\u65F6\u95F4\u7EBF"
        }),
        children: /*#__PURE__*/_jsx("div", {
          style: {
            padding: 8
          },
          children: /*#__PURE__*/_jsx(EventTimeline, {
            events: timeline,
            maxHeight: 360,
            emptyText: loading && !data ? '正在读取…' : '暂无事件'
          })
        })
      })]
    })]
  });
}