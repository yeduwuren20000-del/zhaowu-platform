import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.mjs';
import './styles/theme.css';
import './styles/global.css';
import './styles/components.css';
import './styles/ssh.css';
import './styles/groups.css';
import './styles/timeline.css';
import './styles/resources.css';
import './styles/trend.css';
import { jsx as _jsx } from "react/jsx-runtime";
createRoot(document.getElementById('root')).render(/*#__PURE__*/_jsx(StrictMode, {
  children: /*#__PURE__*/_jsx(App, {})
}));

// 首屏骨架（index.html 里的 #boot）在 React 接管后就没用了，必须移除，
// 否则它会盖在页面上方 —— 实测它只有 display:flex，没有 pointer-events 限制。
const boot = document.getElementById('boot');
if (boot) {
  const clearBoot = () => {
    if (boot.parentNode) boot.parentNode.removeChild(boot);
  };
  // 等首帧真正画出来再移除，避免"移除骨架"和"绘制页面"之间又闪一下空白
  requestAnimationFrame(() => requestAnimationFrame(clearBoot));
}