import { Modal } from './ui.mjs';
import { Icon } from './Icons.mjs';

/**
 * 使用说明：每个页面一句话说清「解决什么问题」。
 * 放在侧栏底部随时可看 —— 新手不敢乱点的原因多半是"不知道这页是干嘛的"。
 */
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
const PAGES = [{
  icon: 'dashboard',
  name: '总览',
  desc: '一眼看现在：哪些在跑、有没有异常、缺什么依赖、最近发生过什么'
}, {
  icon: 'folder',
  name: '本地项目',
  desc: '登记本机项目后一键启停；启动失败会给出原因和下一步，不用先看懂日志'
}, {
  icon: 'server',
  name: '服务器',
  desc: '添加 SSH 服务器，只读采集 CPU / 内存 / 端口 / 容器'
}, {
  icon: 'ports',
  name: '服务端口',
  desc: '谁占了哪个端口、有没有冲突，可一键重新探测'
}, {
  icon: 'box',
  name: 'WSL',
  desc: '看 WSL 发行版的状态与占用，可采集进程列表'
}, {
  icon: 'link',
  name: '网盘直链',
  desc: '粘贴网盘分享链接，取回可直接下载的直链'
}, {
  icon: 'shield',
  name: '凭据库',
  desc: '密码 / 私钥 / Token 存在本机，默认打码、点开才显示'
}, {
  icon: 'terminal',
  name: '日志',
  desc: '项目与服务的日志集中在这，支持实时跟随'
}, {
  icon: 'clock',
  name: '时间线',
  desc: '事件记录：项目什么时候启动过、停过、报过错'
}, {
  icon: 'settings',
  name: '设置',
  desc: '主题、自动发现、自动监控等偏好都在这'
}];
export function HelpModal({
  open,
  onClose
}) {
  return /*#__PURE__*/_jsxs(Modal, {
    open: open,
    title: "\u4F7F\u7528\u8BF4\u660E",
    onClose: onClose,
    size: "md",
    children: [/*#__PURE__*/_jsx("div", {
      className: "help-list",
      children: PAGES.map(page => /*#__PURE__*/_jsxs("div", {
        className: "help-list__item",
        children: [/*#__PURE__*/_jsx("span", {
          className: "help-list__icon",
          children: /*#__PURE__*/_jsx(Icon, {
            name: page.icon,
            size: 14
          })
        }), /*#__PURE__*/_jsxs("div", {
          children: [/*#__PURE__*/_jsx("div", {
            className: "help-list__name",
            children: page.name
          }), /*#__PURE__*/_jsx("div", {
            className: "help-list__desc",
            children: page.desc
          })]
        })]
      }, page.name))
    }), /*#__PURE__*/_jsx("div", {
      className: "help-list__foot",
      children: "\u65B0\u624B\u53EA\u9700\u4E24\u6B65\uFF1A\u5728\u300C\u672C\u5730\u9879\u76EE\u300D\u767B\u8BB0\u5E76\u542F\u52A8\uFF0C\u56DE\u300C\u603B\u89C8\u300D\u770B\u6709\u6CA1\u6709\u5F02\u5E38\u3002\u5176\u4F59\u9875\u9762\u8981\u7528\u518D\u70B9\u3002"
    })]
  });
}