import { useState } from 'react';
import { Icon } from './Icons.mjs';
import { Button } from './ui.mjs';
import { copyText } from '../utils/clipboard.js';

/**
 * 启动失败横幅（挂在项目卡片里，启动失败后常驻，直到下次启动成功或手动关掉）：
 *   标题说人话 → 证据（日志里到底哪一行触发了判断）→ 建议动作（可复制命令 / 可跳转页面）→ 日志尾部
 *
 * 设计要点：
 *   - 不用 toast 承载：toast 几秒就消失，新手来不及读；失败原因要停在原地看着；
 *   - 每条建议都可以带一个动作：copy = 复制命令让用户去终端粘贴，navigate = 跳到能解决问题的页面；
 *   - 日志尾部默认折叠——想看的人展开，不想看的人不被原始报错吓到。
 */
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function StartFailureCard({
  failure,
  onNavigate,
  onDismiss
}) {
  const [showLog, setShowLog] = useState(false);
  const [copied, setCopied] = useState('');
  if (!failure) return null;
  const advice = Array.isArray(failure.advice) ? failure.advice : [];
  const logTail = Array.isArray(failure.logTail) ? failure.logTail : [];
  return /*#__PURE__*/_jsxs("div", {
    className: "pfail",
    role: "alert",
    children: [/*#__PURE__*/_jsxs("div", {
      className: "pfail__head",
      children: [/*#__PURE__*/_jsx(Icon, {
        name: "alert",
        size: 14
      }), /*#__PURE__*/_jsx("span", {
        className: "pfail__title",
        children: failure.title || '启动失败'
      }), onDismiss ? /*#__PURE__*/_jsx("button", {
        type: "button",
        className: "pfail__close",
        title: "\u77E5\u9053\u4E86\uFF0C\u6536\u8D77",
        "aria-label": "\u6536\u8D77\u5931\u8D25\u63D0\u793A",
        onClick: onDismiss,
        children: /*#__PURE__*/_jsx(Icon, {
          name: "x",
          size: 12
        })
      }) : null]
    }), failure.summary ? /*#__PURE__*/_jsx("p", {
      className: "pfail__summary",
      children: failure.summary
    }) : null, failure.evidence ? /*#__PURE__*/_jsxs("p", {
      className: "pfail__evidence",
      title: "\u8BCA\u65AD\u4F9D\u636E\uFF1A\u65E5\u5FD7\u91CC\u5B9E\u9645\u51FA\u73B0\u7684\u8FD9\u4E00\u884C",
      children: [/*#__PURE__*/_jsx("span", {
        className: "pfail__evidence-label",
        children: "\u65E5\u5FD7\u91CC\u8BF4"
      }), /*#__PURE__*/_jsx("code", {
        children: failure.evidence
      })]
    }) : null, advice.length > 0 ? /*#__PURE__*/_jsx("ul", {
      className: "pfail__advice",
      children: advice.map((item, index) => /*#__PURE__*/_jsxs("li", {
        children: [/*#__PURE__*/_jsx("span", {
          className: "pfail__advice-text",
          children: item.text
        }), item.action?.kind === 'copy' && item.action.value ? /*#__PURE__*/_jsx(Button, {
          size: "sm",
          icon: "copy",
          onClick: async () => {
            const ok = await copyText(item.action.value);
            setCopied(ok ? `已复制：${item.action.value}` : '复制失败，请手动选择文本复制');
          },
          children: "\u590D\u5236\u547D\u4EE4"
        }) : null, item.action?.kind === 'navigate' ? /*#__PURE__*/_jsx(Button, {
          size: "sm",
          icon: "arrowUpRight",
          onClick: () => onNavigate?.(item.action),
          children: item.action.to === '/logs' ? '看日志' : item.action.to === '/ports' ? '看端口占用' : '去处理'
        }) : null]
      }, `${item.text}-${index}`))
    }) : null, /*#__PURE__*/_jsx("p", {
      className: "pfail__copied",
      "aria-live": "polite",
      children: copied
    }), logTail.length > 0 ? /*#__PURE__*/_jsxs("div", {
      className: "pfail__log",
      children: [/*#__PURE__*/_jsxs("button", {
        type: "button",
        className: "pfail__log-toggle",
        onClick: () => setShowLog(prev => !prev),
        children: [/*#__PURE__*/_jsx(Icon, {
          name: showLog ? 'chevronDown' : 'chevronRight',
          size: 11
        }), showLog ? '收起日志尾部' : `展开日志尾部（${logTail.length} 行）`]
      }), showLog ? /*#__PURE__*/_jsx("pre", {
        className: "pfail__log-body",
        children: logTail.join('\n')
      }) : null]
    }) : null]
  });
}