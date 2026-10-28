import { useEffect, useState } from 'react';
import { Icon } from './Icons.mjs';
import { Button } from './ui.mjs';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
const DISMISS_KEY = 'dsm.onboarding.dismissed.v1';

/**
 * 首次使用引导：只在「还没有项目」或「有项目但一个都没在跑」时出现。
 *
 * 为什么不用弹层：主动弹窗会打断正在看数据的人；放一张页首卡片，做完自动消失，
 * 对老用户零打扰。步骤完成状态直接从数据推导，不做本地"我完成了"的假打卡。
 */
export function OnboardingCard({
  projects = [],
  onGo
}) {
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === '1');
    } catch {
      /* localStorage 读不到（隐私模式等）就当没关过，显示引导也无妨 */
    }
  }, []);
  const hasProject = projects.length > 0;
  const hasRunning = projects.some(p => p.status === 'running' || p.status === 'starting');
  if (dismissed || hasProject && hasRunning) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* 存不了就只在本次会话隐藏 */
    }
    setDismissed(true);
  };
  const steps = [{
    done: hasProject,
    title: '登记一个本地项目',
    desc: '选目录、填启动命令；只是想管端口的话，命令可以留空',
    action: '去登记',
    go: () => onGo('/projects', {
      create: true
    })
  }, {
    done: hasRunning,
    title: '启动它',
    desc: '启动后自动看到端口占用，日志实时可查',
    action: '去启动',
    go: () => onGo('/projects')
  }, {
    done: false,
    title: '出问题先看端口',
    desc: '服务起不来 / 端口被占，这里会指出是谁占的',
    action: '看端口',
    go: () => onGo('/ports')
  }];
  return /*#__PURE__*/_jsxs("section", {
    className: "card onboard",
    children: [/*#__PURE__*/_jsxs("header", {
      className: "onboard__head",
      children: [/*#__PURE__*/_jsxs("div", {
        children: [/*#__PURE__*/_jsx("div", {
          className: "onboard__title",
          children: "\u7B2C\u4E00\u6B21\u7528\uFF1F\u4E09\u6B65\u4E0A\u624B"
        }), /*#__PURE__*/_jsx("div", {
          className: "onboard__sub",
          children: "\u65E5\u5E38\u7BA1\u7406\u5C31\u8FD9\u4E9B\uFF1A\u5DE6\u8FB9\u300C\u672C\u5730\u9879\u76EE\u300D\u7BA1\u542F\u505C\uFF0C\u8FD9\u91CC\u770B\u6709\u6CA1\u6709\u5F02\u5E38"
        })]
      }), /*#__PURE__*/_jsx("button", {
        type: "button",
        className: "onboard__dismiss",
        onClick: dismiss,
        children: "\u4E0D\u518D\u663E\u793A"
      })]
    }), /*#__PURE__*/_jsx("ol", {
      className: "onboard__steps",
      children: steps.map((step, index) => /*#__PURE__*/_jsxs("li", {
        className: `onboard__step ${step.done ? 'is-done' : ''}`,
        children: [/*#__PURE__*/_jsx("span", {
          className: "onboard__mark",
          children: step.done ? /*#__PURE__*/_jsx(Icon, {
            name: "check",
            size: 12
          }) : index + 1
        }), /*#__PURE__*/_jsxs("div", {
          className: "onboard__text",
          children: [/*#__PURE__*/_jsx("div", {
            className: "onboard__step-title",
            children: step.title
          }), /*#__PURE__*/_jsx("div", {
            className: "onboard__step-desc",
            children: step.desc
          })]
        }), !step.done && step.go ? /*#__PURE__*/_jsx(Button, {
          size: "sm",
          variant: "primary",
          icon: "arrowUpRight",
          onClick: step.go,
          children: step.action
        }) : null]
      }, step.title))
    }), /*#__PURE__*/_jsx("div", {
      className: "onboard__foot",
      children: "\u66F4\u591A\u80FD\u529B\uFF08\u670D\u52A1\u5668\u76D1\u63A7 \xB7 \u51ED\u636E\u5E93 \xB7 \u7F51\u76D8\u76F4\u94FE \xB7 \u65E5\u5FD7\uFF09\u6536\u5728\u5DE6\u4FA7\u300C\u66F4\u591A\u300D\u83DC\u5355\u91CC\uFF0C\u8981\u7528\u518D\u70B9\u3002"
    })]
  });
}