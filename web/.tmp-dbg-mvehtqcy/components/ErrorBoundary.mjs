import { Component } from 'react';
import { Button } from './ui.mjs';
import { Icon } from './Icons.mjs';

/**
 * 页面级兜底：某个页面渲染时抛错，不再整个应用白屏。
 *
 * 为什么需要它：白屏对新手是最坏的情况——没有文字、没有按钮，唯一出路是关掉重开，
 * 而且重开后大概率还是一样。有了它，侧栏和顶栏都还在，用户能去其他页面，
 * 也能一键重试这一页；错误详情折叠着，懂的人按 F12 之外还能直接复制走。
 *
 * 放在 <main> 里包 <Outlet/>，用 location.pathname 做 key：导航到新页面自动重置边界，
 * 崩过的页面不会把用户困在原地。
 */
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = {
      error: null,
      copied: false
    };
  }
  static getDerivedStateFromError(error) {
    return {
      error
    };
  }
  componentDidCatch(error, info) {
    // 控制台留全量（含组件栈），F12 能看到，不打断用户
    console.error('[工作台] 页面渲染出错：', error, info);
  }
  handleRetry = () => {
    this.setState({
      error: null,
      copied: false
    });
  };
  handleCopy = async () => {
    const {
      error
    } = this.state;
    const text = `${error?.name || 'Error'}: ${error?.message || String(error)}\n\n${error?.stack || ''}`;
    try {
      await navigator.clipboard.writeText(text);
      this.setState({
        copied: true
      });
      setTimeout(() => this.setState({
        copied: false
      }), 2000);
    } catch {
      // 剪贴板被浏览器拦了（非 HTTPS / 无权限）：不打扰用户，详情还在折叠区里能手动选
    }
  };
  render() {
    const {
      error,
      copied
    } = this.state;
    if (!error) return this.props.children;
    return /*#__PURE__*/_jsx("div", {
      className: "page-crash",
      role: "alert",
      children: /*#__PURE__*/_jsxs("div", {
        className: "page-crash__card",
        children: [/*#__PURE__*/_jsx("div", {
          className: "page-crash__icon",
          children: /*#__PURE__*/_jsx(Icon, {
            name: "alert",
            size: 18
          })
        }), /*#__PURE__*/_jsx("div", {
          className: "page-crash__title",
          children: "\u8FD9\u4E00\u9875\u51FA\u4E86\u70B9\u95EE\u9898"
        }), /*#__PURE__*/_jsx("div", {
          className: "page-crash__desc",
          children: "\u9875\u9762\u663E\u793A\u65F6\u53D1\u751F\u4E86\u9519\u8BEF\uFF0C\u4F46\u5DE5\u4F5C\u53F0\u672C\u8EAB\u8FD8\u5728\u8FD0\u884C\u3002\u4F60\u53EF\u4EE5\u91CD\u8BD5\u8FD9\u4E00\u9875\uFF0C\u6216\u7528\u5DE6\u4FA7\u5BFC\u822A\u53BB\u5176\u4ED6\u9875\u9762\u2014\u2014\u6570\u636E\u4E0D\u4F1A\u4E22\u3002"
        }), /*#__PURE__*/_jsx("div", {
          className: "page-crash__msg",
          children: error?.message || String(error)
        }), /*#__PURE__*/_jsxs("div", {
          className: "page-crash__actions",
          children: [/*#__PURE__*/_jsx(Button, {
            variant: "primary",
            icon: "refresh",
            onClick: this.handleRetry,
            children: "\u91CD\u8BD5\u8FD9\u4E00\u9875"
          }), /*#__PURE__*/_jsx(Button, {
            icon: copied ? 'check' : 'copy',
            onClick: this.handleCopy,
            children: copied ? '已复制' : '复制错误详情'
          })]
        }), /*#__PURE__*/_jsxs("details", {
          className: "page-crash__detail",
          children: [/*#__PURE__*/_jsx("summary", {
            children: "\u6280\u672F\u8BE6\u60C5\uFF08\u53D1\u7ED9\u61C2\u7684\u4EBA\u770B\uFF09"
          }), /*#__PURE__*/_jsx("pre", {
            children: error?.stack || `${error?.name || 'Error'}: ${error?.message || String(error)}`
          })]
        })]
      })
    });
  }
}