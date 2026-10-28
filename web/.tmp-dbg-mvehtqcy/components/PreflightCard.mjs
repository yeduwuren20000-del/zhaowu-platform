import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { Icon } from './Icons.mjs';
import { Button, Card, ErrorNotice } from './ui.mjs';
import { useToast } from '../hooks/useToast.mjs';
import { copyText } from '../utils/clipboard.js';

/**
 * 环境体检卡：把「这台机器到底缺什么」直接摆在总览页。
 *
 * 为什么要做：新手最常见的失败不是「用错功能」，而是某个依赖没装 / 没进 PATH，
 * 界面上只回一句技术错误，看不出该改什么。这里每项都用真实命令探测过，
 * 缺的直接给出「影响哪个功能 + 怎么装」，命令可点一下复制。
 *
 * 折叠策略：全都就绪时收成一行（不占地方）；有必需项缺失时自动展开并标红。
 * 用户手动开合后以手动为准（manualOpen），避免每次刷新把人家刚展开的又收起来。
 */
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
export function PreflightCard() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [manualOpen, setManualOpen] = useState(null);
  const load = useCallback(async refresh => {
    setLoading(true);
    setError('');
    try {
      setData(await api.preflight(refresh));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load(false);
  }, [load]);
  const items = data?.items || [];
  const summary = data?.summary || {
    total: 0,
    okCount: 0,
    missing: [],
    requiredMissing: []
  };
  const requiredMissing = summary.requiredMissing || [];
  const optionalMissing = (summary.missing || []).filter(id => !requiredMissing.includes(id));
  const open = manualOpen === null ? requiredMissing.length > 0 : manualOpen;
  const copyFix = useCallback(async command => {
    const ok = await copyText(command);
    if (ok) toast.success('已复制安装命令', '粘贴到 PowerShell 里执行即可');else toast.error('复制失败', '请手动选中命令复制');
  }, [toast]);
  const headline = loading && !data ? '检测中…' : `${summary.okCount}/${summary.total} 就绪`;
  return /*#__PURE__*/_jsxs(Card, {
    title: "\u73AF\u5883\u4F53\u68C0",
    icon: "activity",
    subtitle: "\u8FD9\u53F0\u673A\u5668\u7F3A\u4E0D\u7F3A\u5DE5\u4F5C\u53F0\u8981\u7528\u7684\u4E1C\u897F",
    actions: /*#__PURE__*/_jsxs(_Fragment, {
      children: [/*#__PURE__*/_jsx("span", {
        className: `footnote pf__count ${requiredMissing.length > 0 ? 'is-bad' : ''}`,
        children: headline
      }), /*#__PURE__*/_jsx(Button, {
        size: "sm",
        icon: "refresh",
        loading: loading,
        onClick: () => load(true),
        children: "\u91CD\u65B0\u68C0\u6D4B"
      }), /*#__PURE__*/_jsxs("button", {
        type: "button",
        className: "card__toggle",
        "aria-expanded": open,
        onClick: () => setManualOpen(!open),
        children: [/*#__PURE__*/_jsx(Icon, {
          name: open ? 'chevronDown' : 'chevronRight',
          size: 13
        }), open ? '收起' : '查看明细']
      })]
    }),
    children: [error ? /*#__PURE__*/_jsx(ErrorNotice, {
      error: error,
      onRetry: () => load(true).catch(() => {}),
      retryLabel: "\u91CD\u65B0\u4F53\u68C0"
    }) : null, !error && !data && loading ? /*#__PURE__*/_jsx("div", {
      className: "pf__loading",
      children: "\u6B63\u5728\u68C0\u6D4B\u672C\u673A\u4F9D\u8D56\uFF08\u4F1A\u5B9E\u9645\u6267\u884C\u547D\u4EE4\uFF0C\u7EA6 1-3 \u79D2\uFF09\u2026"
    }) : null, data && open ? /*#__PURE__*/_jsxs(_Fragment, {
      children: [requiredMissing.length > 0 ? /*#__PURE__*/_jsxs("div", {
        className: "pf__banner",
        children: [/*#__PURE__*/_jsx(Icon, {
          name: "alert",
          size: 13
        }), "\u6709 ", requiredMissing.length, " \u9879\u5FC5\u9700\u7EC4\u4EF6\u6CA1\u5C31\u7EEA\uFF0C\u5BF9\u5E94\u529F\u80FD\u4F1A\u4E0D\u53EF\u7528\u3002\u6309\u4E0B\u9762\u7684\u63D0\u793A\u88C5\u597D\uFF0C\u518D\u70B9\u300C\u91CD\u65B0\u68C0\u6D4B\u300D\u3002"]
      }) : null, /*#__PURE__*/_jsx("div", {
        className: "pf__list",
        children: items.map(item => {
          const tone = item.ok ? 'ok' : item.required ? 'bad' : 'warn';
          return /*#__PURE__*/_jsxs("div", {
            className: `pf__row is-${tone}`,
            children: [/*#__PURE__*/_jsx("span", {
              className: `pf__dot is-${tone}`
            }), /*#__PURE__*/_jsxs("div", {
              className: "pf__main",
              children: [/*#__PURE__*/_jsxs("div", {
                className: "pf__name",
                children: [item.label, item.required ? null : /*#__PURE__*/_jsx("span", {
                  className: "pf__opt",
                  children: "\u53EF\u9009"
                })]
              }), /*#__PURE__*/_jsx("div", {
                className: "pf__detail",
                children: item.detail || (item.ok ? '可用' : '未检测到')
              }), !item.ok ? /*#__PURE__*/_jsxs("div", {
                className: "pf__fix",
                children: [/*#__PURE__*/_jsx("div", {
                  className: "pf__why",
                  children: item.why
                }), item.fix?.text ? /*#__PURE__*/_jsx("div", {
                  className: "pf__fixtext",
                  children: item.fix.text
                }) : null, item.fix?.command ? /*#__PURE__*/_jsxs("button", {
                  type: "button",
                  className: "pf__cmd",
                  title: "\u70B9\u51FB\u590D\u5236\u5B89\u88C5\u547D\u4EE4",
                  onClick: () => copyFix(item.fix.command),
                  children: [/*#__PURE__*/_jsx(Icon, {
                    name: "copy",
                    size: 11
                  }), /*#__PURE__*/_jsx("code", {
                    children: item.fix.command
                  })]
                }) : null]
              }) : null]
            }), /*#__PURE__*/_jsx("span", {
              className: `pf__state is-${tone}`,
              children: item.ok ? '就绪' : item.required ? '缺失' : '未装'
            })]
          }, item.id);
        })
      })]
    }) : null, data && !open ? /*#__PURE__*/_jsx("div", {
      className: "pf__collapsed",
      children: requiredMissing.length === 0 ? optionalMissing.length === 0 ? '全部就绪，不需要处理。' : `必需项都已就绪；未装的可选项：${items.filter(item => !item.ok && !item.required).map(item => item.label).join('、')}（不影响其它功能）。` : `${requiredMissing.length} 项必需组件缺失，点「查看明细」看怎么装。`
    }) : null]
  });
}
export default PreflightCard;