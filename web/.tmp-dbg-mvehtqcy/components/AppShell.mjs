import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { GlobalSearch } from './GlobalSearch.mjs';
import { HelpModal } from './HelpModal.mjs';
import { Icon } from './Icons.mjs';
import { ErrorBoundary } from './ErrorBoundary.mjs';

/**
 * 导航按"日常用得上的"分层，而不是把 7 个页面平铺：
 *   主场景（常驻）：总览 / 本地项目 / 服务器 —— 覆盖日常 90% 的操作
 *   更多（收纳）  ：服务端口 / 日志 / 时间线 / 设置
 * 这样侧栏一眼能扫完，低频功能按需展开，功能一个没少。
 */
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
const NAV_MAIN = [{
  to: '/',
  label: '总览',
  icon: 'dashboard',
  end: true,
  hint: '现在怎么样'
}, {
  to: '/projects',
  label: '本地项目',
  icon: 'folder',
  hint: '启动 / 停止'
}, {
  to: '/servers',
  label: '服务器',
  icon: 'server',
  hint: '远程资源'
}];
const NAV_MORE = [{
  to: '/ports',
  label: '服务端口',
  icon: 'ports'
}, {
  to: '/wsl',
  label: 'WSL',
  icon: 'box'
}, {
  to: '/pans',
  label: '网盘直链',
  icon: 'link'
}, {
  to: '/vault',
  label: '凭据库',
  icon: 'shield'
}, {
  to: '/logs',
  label: '日志',
  icon: 'terminal'
}, {
  to: '/timeline',
  label: '时间线',
  icon: 'clock'
}, {
  to: '/settings',
  label: '设置',
  icon: 'settings'
}];
const MORE_LABEL = {
  '/ports': '服务端口',
  '/wsl': 'WSL',
  '/pans': '网盘直链',
  '/vault': '凭据库',
  '/logs': '日志',
  '/timeline': '时间线',
  '/settings': '设置'
};
export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const moreRef = useRef(null);
  const addRef = useRef(null);

  // 当前是否落在「更多」里的页面（用于高亮"更多"按钮）
  const inMore = MORE_LABEL[location.pathname];
  useEffect(() => {
    setMoreOpen(false);
    setAddOpen(false);
  }, [location.pathname]);

  // 点击外部关闭两个下拉
  useEffect(() => {
    const onDown = event => {
      if (moreRef.current && !moreRef.current.contains(event.target)) setMoreOpen(false);
      if (addRef.current && !addRef.current.contains(event.target)) setAddOpen(false);
    };
    const onKey = event => {
      if (event.key === 'Escape') {
        setMoreOpen(false);
        setAddOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  return /*#__PURE__*/_jsxs("div", {
    className: "app-shell",
    children: [/*#__PURE__*/_jsxs("aside", {
      className: "sidebar",
      children: [/*#__PURE__*/_jsxs("div", {
        className: "brand",
        children: [/*#__PURE__*/_jsx("span", {
          className: "brand__logo",
          children: /*#__PURE__*/_jsx(Icon, {
            name: "layers",
            size: 14
          })
        }), /*#__PURE__*/_jsx("div", {
          className: "brand__title",
          children: "\u5DE5\u4F5C\u53F0"
        })]
      }), /*#__PURE__*/_jsxs("nav", {
        className: "nav",
        children: [NAV_MAIN.map(item => /*#__PURE__*/_jsxs(NavLink, {
          to: item.to,
          end: item.end,
          className: ({
            isActive
          }) => `nav__item ${isActive ? 'is-active' : ''}`,
          children: [/*#__PURE__*/_jsx(Icon, {
            name: item.icon,
            size: 15
          }), /*#__PURE__*/_jsx("span", {
            className: "nav__label",
            children: item.label
          }), item.hint ? /*#__PURE__*/_jsx("span", {
            className: "nav__hint",
            children: item.hint
          }) : null]
        }, item.to)), /*#__PURE__*/_jsxs("div", {
          className: "nav__more-wrap",
          ref: moreRef,
          children: [/*#__PURE__*/_jsxs("button", {
            type: "button",
            className: `nav__item nav__item--more ${inMore ? 'is-active' : ''}`,
            onClick: () => setMoreOpen(prev => !prev),
            title: "\u66F4\u591A\u529F\u80FD",
            children: [/*#__PURE__*/_jsx(Icon, {
              name: "more",
              size: 15
            }), /*#__PURE__*/_jsx("span", {
              className: "nav__label",
              children: "\u66F4\u591A"
            }), /*#__PURE__*/_jsx(Icon, {
              name: moreOpen ? 'chevronDown' : 'chevronRight',
              size: 12,
              style: {
                marginLeft: 'auto',
                opacity: 0.6
              }
            })]
          }), moreOpen || inMore ? /*#__PURE__*/_jsx("div", {
            className: "nav__sub",
            children: NAV_MORE.map(item => /*#__PURE__*/_jsxs(NavLink, {
              to: item.to,
              className: ({
                isActive
              }) => `nav__subitem ${isActive ? 'is-active' : ''}`,
              children: [/*#__PURE__*/_jsx(Icon, {
                name: item.icon,
                size: 14
              }), item.label]
            }, item.to))
          }) : null]
        })]
      }), /*#__PURE__*/_jsx("div", {
        className: "sidebar__foot",
        children: /*#__PURE__*/_jsxs("button", {
          type: "button",
          className: "sidebar__help",
          onClick: () => setHelpOpen(true),
          children: [/*#__PURE__*/_jsx(Icon, {
            name: "alert",
            size: 13
          }), "\u6BCF\u4E2A\u9875\u9762\u662F\u5E72\u561B\u7684\uFF1F"]
        })
      })]
    }), /*#__PURE__*/_jsxs("div", {
      className: "main",
      children: [/*#__PURE__*/_jsxs("header", {
        className: "topbar",
        children: [/*#__PURE__*/_jsx(GlobalSearch, {}), /*#__PURE__*/_jsx("div", {
          className: "topbar__actions",
          children: /*#__PURE__*/_jsxs("div", {
            className: "menu-wrap",
            ref: addRef,
            children: [/*#__PURE__*/_jsxs("button", {
              type: "button",
              className: "btn btn--primary",
              onClick: () => setAddOpen(prev => !prev),
              children: [/*#__PURE__*/_jsx(Icon, {
                name: "plus",
                size: 13
              }), "\u65B0\u589E", /*#__PURE__*/_jsx(Icon, {
                name: "chevronDown",
                size: 11,
                style: {
                  opacity: 0.75
                }
              })]
            }), addOpen ? /*#__PURE__*/_jsxs("div", {
              className: "menu menu--right",
              children: [/*#__PURE__*/_jsxs("button", {
                type: "button",
                className: "menu__item",
                onClick: () => navigate('/projects', {
                  state: {
                    create: true,
                    from: location.pathname
                  }
                }),
                children: [/*#__PURE__*/_jsx(Icon, {
                  name: "folder",
                  size: 14
                }), "\u672C\u5730\u9879\u76EE", /*#__PURE__*/_jsx("span", {
                  className: "menu__hint",
                  children: "\u76EE\u5F55 + \u542F\u52A8\u547D\u4EE4\uFF0C\u4E00\u952E\u542F\u505C"
                })]
              }), /*#__PURE__*/_jsxs("button", {
                type: "button",
                className: "menu__item",
                onClick: () => navigate('/servers', {
                  state: {
                    create: true,
                    from: location.pathname
                  }
                }),
                children: [/*#__PURE__*/_jsx(Icon, {
                  name: "server",
                  size: 14
                }), "\u670D\u52A1\u5668", /*#__PURE__*/_jsx("span", {
                  className: "menu__hint",
                  children: "SSH \u53EA\u8BFB\u91C7\u96C6 CPU / \u5185\u5B58 / \u7AEF\u53E3"
                })]
              })]
            }) : null]
          })
        })]
      }), /*#__PURE__*/_jsx("main", {
        className: "content",
        children: /*#__PURE__*/_jsx(ErrorBoundary, {
          children: /*#__PURE__*/_jsx(Outlet, {})
        }, location.pathname)
      })]
    }), /*#__PURE__*/_jsx(HelpModal, {
      open: helpOpen,
      onClose: () => setHelpOpen(false)
    })]
  });
}