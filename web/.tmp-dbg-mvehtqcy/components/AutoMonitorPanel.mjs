import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { Icon } from './Icons.mjs';
import { Button } from './ui.mjs';
import { formatDateTime, timeAgo } from '../utils/format.js';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
const INTERVALS = [{
  value: 60000,
  label: '1 分钟'
}, {
  value: 120000,
  label: '2 分钟'
}, {
  value: 300000,
  label: '5 分钟'
}, {
  value: 600000,
  label: '10 分钟'
}, {
  value: 1800000,
  label: '30 分钟'
}];

/**
 * SSH 自动刷新面板（第七阶段·第二轮）。
 *
 * 与页面右上角的「自动刷新(60s)」不同：
 *   - 那个开关只是**前端定时拉取列表**，离开页面就停；
 *   - 这个开关让**后端定时器**按间隔去采集服务器，关掉页面也继续跑，设置持久化。
 * 后端带熔断退避：连续失败的机器会被暂停，不会把日志刷爆。
 */
export function AutoMonitorPanel({
  onChanged
}) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    try {
      setStatus(await api.autoMonitor());
    } catch {
      /* 状态读不到不影响页面，静默 */
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // 开着面板就每 15 秒同步一次后端状态
  useEffect(() => {
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);
  async function act(key, fn, done) {
    setBusy(key);
    try {
      await fn();
      await load();
      onChanged?.();
      if (done) done();
    } catch (error) {
      console.warn('[auto-monitor]', error.message);
    } finally {
      setBusy('');
    }
  }
  const toggle = checked => act('toggle', async () => {
    if (checked) await api.autoMonitorStart(status?.settings?.intervalMs);else await api.autoMonitorStop();
  });
  const changeInterval = value => act('interval', () => api.autoMonitorInterval(Number(value)));
  const runNow = () => act('run', () => api.autoMonitorRun());
  if (!status) return null;
  const {
    settings,
    running,
    lastRun,
    heldServers = []
  } = status;
  const held = heldServers.length;
  return /*#__PURE__*/_jsxs("div", {
    className: "am-panel",
    children: [/*#__PURE__*/_jsxs("div", {
      className: "am-panel__main",
      children: [/*#__PURE__*/_jsxs("label", {
        className: "am-switch",
        children: [/*#__PURE__*/_jsx("input", {
          type: "checkbox",
          checked: Boolean(running),
          onChange: event => toggle(event.target.checked)
        }), /*#__PURE__*/_jsx("span", {
          className: "am-switch__track",
          "aria-hidden": true
        }), /*#__PURE__*/_jsxs("span", {
          className: "am-switch__label",
          children: [/*#__PURE__*/_jsx(Icon, {
            name: "clock",
            size: 13
          }), "\u540E\u53F0\u81EA\u52A8\u91C7\u96C6"]
        })]
      }), /*#__PURE__*/_jsx("select", {
        className: "select am-interval",
        value: settings.intervalMs,
        onChange: event => changeInterval(event.target.value),
        title: "\u91C7\u96C6\u95F4\u9694",
        children: INTERVALS.map(item => /*#__PURE__*/_jsxs("option", {
          value: item.value,
          children: ["\u6BCF ", item.label]
        }, item.value))
      }), /*#__PURE__*/_jsx(Button, {
        size: "sm",
        icon: "wifi",
        loading: busy === 'run',
        onClick: runNow,
        title: "\u7ACB\u523B\u6309\u540C\u6837\u7684\u7194\u65AD\u89C4\u5219\u91C7\u96C6\u4E00\u8F6E",
        children: "\u7ACB\u5373\u91C7\u96C6\u4E00\u8F6E"
      }), /*#__PURE__*/_jsxs("span", {
        className: "am-panel__state",
        children: [running ? /*#__PURE__*/_jsx("span", {
          className: "status-word",
          children: "\u8FD0\u884C\u4E2D"
        }) : /*#__PURE__*/_jsx("span", {
          className: "status-word muted",
          children: "\u5DF2\u505C\u6B62"
        }), lastRun ? /*#__PURE__*/_jsxs("span", {
          className: "footnote",
          children: ["\u4E0A\u6B21 ", timeAgo(lastRun.at), " \xB7 \u91C7\u96C6 ", lastRun.probed, " \u53F0 \xB7 \u6210\u529F ", lastRun.ok, " \xB7 \u5931\u8D25 ", lastRun.failed, lastRun.onHold ? ` · 暂停 ${lastRun.onHold}` : '', lastRun.timeout ? ' · 本轮超时' : '']
        }) : /*#__PURE__*/_jsx("span", {
          className: "footnote",
          children: "\u8FD8\u6CA1\u6709\u81EA\u52A8\u91C7\u96C6\u8FC7"
        })]
      })]
    }), held > 0 ? /*#__PURE__*/_jsxs("div", {
      className: "am-held",
      children: [/*#__PURE__*/_jsxs("span", {
        className: "footnote",
        children: [/*#__PURE__*/_jsx(Icon, {
          name: "shield",
          size: 12
        }), " ", held, " \u53F0\u673A\u5668\u8FDE\u7EED\u5931\u8D25\uFF0C\u5DF2\u6682\u505C\u81EA\u52A8\u91CD\u8BD5\uFF08\u9000\u907F\u4E2D\uFF09\uFF1A"]
      }), heldServers.slice(0, 4).map(item => /*#__PURE__*/_jsxs("span", {
        className: "tech",
        title: item.lastError || '',
        children: [item.name || item.serverId, " \xB7 ", item.failures, " \u6B21 \xB7 ", item.retryAfter ? `${formatDateTime(item.retryAfter).slice(11, 16)} 后重试` : '']
      }, item.serverId)), heldServers.length > 4 ? /*#__PURE__*/_jsxs("span", {
        className: "tech muted",
        children: ["\u7B49 ", heldServers.length, " \u53F0"]
      }) : null]
    }) : null, /*#__PURE__*/_jsxs("div", {
      className: "footnote am-panel__hint",
      children: ["\u4E0E\u53F3\u4E0A\u89D2\u300C\u81EA\u52A8\u5237\u65B0\u300D\u4E0D\u540C\uFF1A\u8FD9\u4E2A\u5F00\u5173\u8BA9", /*#__PURE__*/_jsx("b", {
        children: "\u540E\u7AEF\u5B9A\u65F6\u5668"
      }), "\u6309\u95F4\u9694\u91C7\u96C6\uFF0C\u5173\u95ED\u9875\u9762\u4E5F\u7EE7\u7EED\uFF1B\u8FDE\u7EED\u5931\u8D25\u7684\u673A\u5668\u4F1A\u81EA\u52A8\u9000\u907F\uFF0C\u4E0D\u4F1A\u5237\u7206\u65E5\u5FD7\u3002"]
    })]
  });
}