import { Icon } from './Icons.mjs';
import { Button, Menu, StatusDot, statusLabel } from './ui.mjs';
import { StartFailureCard } from './StartFailureCard.mjs';
import { formatBytes, formatDuration, groupStatusWord, localUrl } from '../utils/format.js';

/**
 * 项目行（紧凑列表）：默认只显示名称、技术栈、路径、状态、端口、PID。
 * 次要操作在 hover / 聚焦 / 展开时才出现，避免整页都是按钮。
 */
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function ProjectCard({
  project,
  action,
  onStart,
  onStop,
  onRestart,
  onOpenDir,
  onOpenUrl,
  onLog,
  onEdit,
  onDelete,
  onCopyUrl,
  onNavigate,
  failure = null,
  onDismissFailure = null,
  showRemark = true,
  serviceSummary = null,
  groupStatus = null,
  expanded = false,
  onToggleExpand = null
}) {
  const busy = Boolean(action);
  const url = localUrl(project);
  const running = project.status === 'running' || project.status === 'starting';
  return /*#__PURE__*/_jsxs("div", {
    className: `project-row ${expanded ? 'is-open' : ''}`,
    children: [/*#__PURE__*/_jsxs("div", {
      className: "project-row__main",
      children: [/*#__PURE__*/_jsxs("div", {
        className: "project-row__title",
        children: [/*#__PURE__*/_jsx(StatusDot, {
          status: project.status
        }), /*#__PURE__*/_jsx("span", {
          className: "project-row__name",
          children: project.name
        }), /*#__PURE__*/_jsx("span", {
          className: "status-word",
          children: statusLabel(project.status)
        }), project.type ? /*#__PURE__*/_jsx("span", {
          className: "tech muted",
          children: project.type
        }) : null, !project.dirExists ? /*#__PURE__*/_jsx("span", {
          className: "status-word is-error",
          children: "\u76EE\u5F55\u4E0D\u5B58\u5728"
        }) : null, groupStatus && (groupStatus.tone === 'red' || groupStatus.tone === 'amber') ? /*#__PURE__*/_jsxs("span", {
          className: `status-word ${groupStatus.tone === 'red' ? 'is-error' : 'is-warn'}`,
          children: ["\u5B50\u670D\u52A1\u6574\u4F53 ", groupStatusWord(groupStatus.status)]
        }) : null]
      }), /*#__PURE__*/_jsxs("div", {
        className: "project-row__facts",
        children: [/*#__PURE__*/_jsxs("span", {
          children: ["\u7AEF\u53E3 ", /*#__PURE__*/_jsx("b", {
            children: project.port ?? '—'
          })]
        }), /*#__PURE__*/_jsxs("span", {
          children: ["PID ", /*#__PURE__*/_jsx("b", {
            children: project.pid ?? '—'
          }), project.processName ? /*#__PURE__*/_jsx("em", {
            children: project.processName
          }) : null]
        }), /*#__PURE__*/_jsxs("span", {
          children: ["\u5185\u5B58 ", /*#__PURE__*/_jsx("b", {
            children: formatBytes(project.memory)
          })]
        }), /*#__PURE__*/_jsxs("span", {
          children: ["\u8FD0\u884C ", /*#__PURE__*/_jsx("b", {
            children: running ? formatDuration(project.uptimeMs) : '—'
          })]
        }), serviceSummary ? /*#__PURE__*/_jsxs("button", {
          type: "button",
          className: "project-row__toggle",
          onClick: () => onToggleExpand?.(project.id),
          title: expanded ? '收起子服务' : '展开子服务',
          children: [/*#__PURE__*/_jsx(Icon, {
            name: expanded ? 'chevronDown' : 'chevronRight',
            size: 11
          }), "\u5B50\u670D\u52A1 ", serviceSummary.ports, " \u7AEF\u53E3 / ", serviceSummary.processes, " \u8FDB\u7A0B", serviceSummary.newSubServices > 0 ? /*#__PURE__*/_jsxs("em", {
            className: "is-warn",
            children: ["\u65B0 ", serviceSummary.newSubServices]
          }) : null]
        }) : null]
      }), /*#__PURE__*/_jsxs("div", {
        className: `project-row__path ${project.dirExists ? '' : 'is-missing'}`,
        title: project.dir,
        children: [project.dir || '未配置目录', url ? /*#__PURE__*/_jsx("span", {
          className: "project-row__url",
          onClick: () => onOpenUrl?.(project),
          title: "\u7528\u9ED8\u8BA4\u6D4F\u89C8\u5668\u6253\u5F00",
          children: url
        }) : null]
      }), showRemark && project.conflict ? /*#__PURE__*/_jsx("div", {
        className: "status-word is-error",
        children: project.conflict.message
      }) : null, showRemark && !project.conflict && project.remark ? /*#__PURE__*/_jsx("div", {
        className: "project-row__remark",
        children: project.remark
      }) : null, failure ? /*#__PURE__*/_jsx(StartFailureCard, {
        failure: failure,
        onNavigate: onNavigate,
        onDismiss: () => onDismissFailure?.(project.id)
      }) : null]
    }), /*#__PURE__*/_jsxs("div", {
      className: "project-row__actions",
      children: [/*#__PURE__*/_jsx(Button, {
        size: "sm",
        variant: running ? undefined : 'primary',
        icon: running ? 'stop' : 'play',
        loading: action === 'start' || action === 'stop' || action === 'restart',
        disabled: busy,
        onClick: () => running ? onStop?.(project) : onStart?.(project),
        children: running ? '停止' : '启动'
      }), /*#__PURE__*/_jsx(Menu, {
        align: "right",
        width: 196,
        label: `${project.name} 的更多操作`,
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
          key: 'restart',
          label: '重启',
          icon: 'restart',
          disabled: busy || !running,
          onClick: () => onRestart?.(project)
        }, {
          key: 'dir',
          label: '打开目录',
          icon: 'folderOpen',
          hint: project.dir || '',
          onClick: () => onOpenDir?.(project)
        }, {
          key: 'url',
          label: '打开网页',
          icon: 'external',
          hint: url || '未设置访问地址',
          disabled: !url,
          onClick: () => onOpenUrl?.(project)
        }, {
          key: 'log',
          label: '查看日志',
          icon: 'fileText',
          onClick: () => onLog?.(project)
        }, {
          key: 'copy',
          label: '复制访问地址',
          icon: 'copy',
          disabled: !url,
          onClick: () => onCopyUrl?.(project)
        }, {
          key: 'edit',
          label: '编辑项目',
          icon: 'edit',
          onClick: () => onEdit?.(project)
        }, {
          key: 'delete',
          label: '删除项目',
          icon: 'trash',
          danger: true,
          onClick: () => onDelete?.(project)
        }]
      })]
    })]
  });
}