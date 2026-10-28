import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { Icon } from '../components/Icons.mjs';
import { Button, Card, EmptyState, ErrorNotice, Field, Loading, Notice, SearchBox, Switch, Tabs } from '../components/ui.mjs';
import { useToast } from '../hooks/useToast.mjs';
import { PageHint } from '../components/PageHint.mjs';
import { copyText } from '../utils/clipboard.js';
import { formatBytes } from '../utils/format.js';

/**
 * 网盘直链：粘贴分享链接 -> 拿到可直接下载的 URL。
 *
 * 为什么值得单独一页：网盘网页版只给「转存再下载」，直链藏在需要签名/登录态的接口后面。
 * 这里复用已调通的 8 家解析能力（tools/panlink），拿到的链接可以丢给 aria2 跑满带宽。
 *
 * 凭据为什么按网盘分开存：各家要的 Cookie 完全不同，百度是 BDUSS、天翼是 SESSION。
 * 只用一个槽位会出现「填了百度、切到天翼还带着百度的 Cookie 发过去」——报错还看不出来原因。
 * 所以这里一个网盘一个槽位，切网盘自动带出各自的那份，切走前先把当前输入存回原槽位。
 *
 * 边界：只解析、不下载；凭据只留在本机浏览器，不写后端。
 */
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
const CRED_STORE_KEY = 'dsm.pan.credentials.v2';
const CRED_LEGACY_KEY = 'dsm.pan.credentials.v1';
const HISTORY_KEY = 'dsm.pan.history.v1';
const SLOT_AUTO = '*'; // 自动识别（未指定网盘）用的槽位
const HISTORY_MAX = 8;
function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/** 读凭据槽位；兼容上一版「一锅端」的单槽位格式，迁移到自动识别槽 */
function loadSlots() {
  const stored = readJSON(CRED_STORE_KEY, null);
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) return stored;
  const legacy = readJSON(CRED_LEGACY_KEY, null);
  if (legacy && (legacy.cookie || legacy.token)) {
    return {
      [SLOT_AUTO]: {
        cookie: legacy.cookie || '',
        token: legacy.token || ''
      }
    };
  }
  return {};
}
function slotLabel(key) {
  return key === SLOT_AUTO ? '自动识别' : key;
}
function relativeTime(ts) {
  const value = Number(ts);
  if (!Number.isFinite(value) || value <= 0) return '';
  const diff = Date.now() - value;
  if (diff < 0) return '';
  const minute = Math.floor(diff / 60000);
  if (minute < 1) return '刚刚';
  if (minute < 60) return `${minute} 分钟前`;
  const hour = Math.floor(minute / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  const date = new Date(value);
  return `${date.getMonth() + 1}-${date.getDate()}`;
}

/**
 * 从网盘的 authHint 反推它需要哪种凭据。
 * 只对「需要登录」的网盘判断——夸克 / 115 的提示文案里也会提到 --cookie（可选项），
 * 不能因为文案里出现这个词就当成必填，否则游客可用的网盘也会被标成「本网盘需要」。
 * 后端只给了提示文案没给枚举字段，这里按提示里的参数名判断——文案改动时需同步。
 */
function credentialNeed(panItem) {
  if (!panItem?.requiresAuth) return {
    cookie: false,
    token: false
  };
  const hint = panItem.authHint || '';
  return {
    cookie: /--cookie|Cookie|BDUSS|SESSION/i.test(hint),
    token: /--token|Bearer/i.test(hint)
  };
}

/**
 * 把后端/平台抛回来的原始错误翻成「发生了什么 + 下一步做什么」。
 * 新手最容易卡在这里：原文案是技术描述，看不出该改哪一步。
 */
function explainError(message) {
  const text = String(message || '');
  if (!text) return null;
  if (/-guest|游客/i.test(text)) {
    return {
      title: '这个分享支持游客态，不用登录',
      tips: ['勾选「游客态解析」再试一次', '游客态拿不到的（部分加密分享）再回来填凭据'],
      primary: 'guest'
    };
  }
  if (/9019|need\s*verify|滑块|风控|risk/i.test(text)) {
    return {
      title: '被平台风控拦住了（不是你操作错了）',
      tips: ['换家庭宽带 / 关掉代理再试——数据中心 IP 常被判定为风险出口', '在「登录凭据」里填该网盘的 Cookie，登录态能显著降低风控概率', '刚连续试过多次也会触发，等几分钟再来'],
      primary: 'cookie'
    };
  }
  if (/captcha|验证码/i.test(text)) {
    return {
      title: '该网盘要求人工验证',
      tips: ['迅雷等会强制验证码，先去官网网页版手动通过一次', '带上登录 Cookie 通常可以跳过这一步'],
      primary: 'cookie'
    };
  }
  if (/cookie|登录态|BDUSS|__puus|SESSION|token|Bearer|需要登录/i.test(text)) {
    return {
      title: '这个分享需要登录态才能取链',
      tips: ['展开「登录凭据」粘贴该网盘的 Cookie（浏览器登录后从开发者工具复制整串）', '阿里云盘用 Token 而不是 Cookie'],
      primary: 'cookie'
    };
  }
  if (/不存在|已失效|NotFound|ShareInfo|Invalid|已删除|提取码/i.test(text)) {
    return {
      title: '分享不存在、已失效，或提取码不对',
      tips: ['先在浏览器里打开这个链接，确认还能正常看', '有提取码的话填进「提取码」再试'],
      primary: 'url'
    };
  }
  if (/超时|timeout|ETIMEDOUT|ECONN|fetch failed/i.test(text)) {
    return {
      title: '网络请求超时',
      tips: ['检查网络 / 代理是否通', '大分享逐文件取链较慢，稍等重试'],
      primary: 'retry'
    };
  }
  return null;
}
export function PansPage() {
  const toast = useToast();
  const [pans, setPans] = useState([]);
  const [pansError, setPansError] = useState('');
  const [loadingPans, setLoadingPans] = useState(true);
  const [url, setUrl] = useState('');
  const [pan, setPan] = useState(''); // 空 = 自动识别
  const [pwd, setPwd] = useState('');
  const [guest, setGuest] = useState(false);
  const [cookie, setCookie] = useState('');
  const [token, setToken] = useState('');
  const [remember, setRemember] = useState(true);
  const [slots, setSlots] = useState({}); // { 网盘名: { cookie, token } }
  const [credOpen, setCredOpen] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  // 结果区筛选：分享目录一大（实测上百项）时，靠这两个控件定位文件比滚动快
  const [fileFilter, setFileFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [history, setHistory] = useState([]);
  const activeKey = pan || SLOT_AUTO;
  const storedActive = Boolean(slots[activeKey] && (slots[activeKey].cookie || slots[activeKey].token));
  useEffect(() => {
    const saved = loadSlots();
    setSlots(saved);
    const initial = saved[SLOT_AUTO];
    if (initial) {
      setCookie(initial.cookie || '');
      setToken(initial.token || '');
      if (initial.cookie || initial.token) setCredOpen(true); // 已存凭据就展开，否则用户看不到自己存过什么
    }
    const savedHistory = readJSON(HISTORY_KEY, []);
    setHistory(Array.isArray(savedHistory) ? savedHistory.slice(0, HISTORY_MAX) : []);
  }, []);
  const loadPans = useCallback(async () => {
    setLoadingPans(true);
    setPansError('');
    try {
      setPans(await api.pans());
    } catch (err) {
      setPansError(err.message);
    } finally {
      setLoadingPans(false);
    }
  }, []);
  useEffect(() => {
    loadPans();
  }, [loadPans]);
  const selectedPan = useMemo(() => pans.find(item => item.name === pan) || null, [pans, pan]);
  const need = useMemo(() => credentialNeed(selectedPan), [selectedPan]);

  // 切到需要登录的网盘时自动展开凭据区：用户接下来必然要填，替他省一次点击
  useEffect(() => {
    if (selectedPan && (credentialNeed(selectedPan).cookie || credentialNeed(selectedPan).token)) {
      setCredOpen(true);
    }
  }, [selectedPan]);
  const persistSlots = useCallback(next => {
    try {
      localStorage.setItem(CRED_STORE_KEY, JSON.stringify(next));
      localStorage.removeItem(CRED_LEGACY_KEY);
    } catch {
      /* 隐私模式 / 配额满：忽略，内存里仍可用 */
    }
  }, []);

  /** 把当前输入存回某个槽位；两边都空就删掉槽位，避免留下空记录 */
  const commitSlot = useCallback((key, cookieValue, tokenValue) => {
    const next = {
      ...slots
    };
    if (cookieValue || tokenValue) next[key] = {
      cookie: cookieValue,
      token: tokenValue
    };else delete next[key];
    setSlots(next);
    if (remember) persistSlots(next);
    return next;
  }, [slots, remember, persistSlots]);
  const switchPan = useCallback(nextPan => {
    // 切走前先把当前输入写回原槽位，否则填了一半再换网盘就白填了
    const next = commitSlot(activeKey, cookie, token);
    const target = next[nextPan || SLOT_AUTO] || {};
    setPan(nextPan);
    setCookie(target.cookie || '');
    setToken(target.token || '');
    // 目标网盘必须登录时，游客态没有意义，顺手关掉避免「开了游客态却还在报需要登录」
    const meta = pans.find(item => item.name === nextPan);
    if (meta?.requiresAuth) setGuest(false);
  }, [commitSlot, activeKey, cookie, token, pans]);
  const clearSlot = useCallback(key => {
    const next = {
      ...slots
    };
    delete next[key];
    setSlots(next);
    persistSlots(next); // 清除是明确意图，即使「自动保存」关着也要落盘
    if (key === activeKey) {
      setCookie('');
      setToken('');
    }
    toast.success('已清除', `${slotLabel(key)} 的凭据`);
  }, [slots, persistSlots, activeKey, toast]);
  const runResolve = useCallback(async ({
    shareUrl,
    panName,
    pwdValue,
    guestValue,
    cookieValue,
    tokenValue
  }) => {
    const target = String(shareUrl || '').trim();
    if (!target) {
      setError('请先粘贴分享链接');
      return;
    }
    setResolving(true);
    setError('');
    setResult(null);
    try {
      const data = await api.resolvePan({
        url: target,
        pan: panName || undefined,
        pwd: pwdValue || undefined,
        // 游客态下凭据本来就不该参与，干脆不发，避免「游客态还带着旧 Cookie」的歧义
        cookie: guestValue ? undefined : cookieValue || undefined,
        token: guestValue ? undefined : tokenValue || undefined,
        guest: guestValue || undefined
      });
      setResult(data);
      setFileFilter('all');
      setQuery('');
      const entry = {
        url: target,
        pan: data.pan || panName || '',
        title: data.title || '',
        count: data.files?.length || 0,
        pwd: pwdValue || '',
        guest: Boolean(guestValue),
        at: Date.now()
      };
      const nextHistory = [entry, ...history.filter(item => item.url !== target)].slice(0, HISTORY_MAX);
      setHistory(nextHistory);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(nextHistory));
      } catch {
        /* 忽略配额问题 */
      }
      toast.success('解析完成', `${data.pan} · ${data.files?.length || 0} 项`);
    } catch (err) {
      setError(err.message);
      toast.error('解析失败', err.message);
    } finally {
      setResolving(false);
    }
  }, [history, toast]);
  const resolve = useCallback(() => {
    commitSlot(activeKey, cookie, token);
    return runResolve({
      shareUrl: url,
      panName: pan,
      pwdValue: pwd,
      guestValue: guest,
      cookieValue: cookie,
      tokenValue: token
    });
  }, [commitSlot, activeKey, cookie, token, url, pan, pwd, guest, runResolve]);
  const reparse = useCallback(entry => {
    const target = slots[entry.pan || SLOT_AUTO] || {};
    setUrl(entry.url);
    setPan(entry.pan || '');
    setPwd(entry.pwd || '');
    setCookie(target.cookie || '');
    setToken(target.token || '');
    setGuest(Boolean(entry.guest));
    runResolve({
      shareUrl: entry.url,
      panName: entry.pan || '',
      pwdValue: entry.pwd || '',
      guestValue: Boolean(entry.guest),
      cookieValue: target.cookie || '',
      tokenValue: target.token || ''
    });
  }, [slots, runResolve]);
  const removeHistory = useCallback(target => {
    const next = history.filter(item => item.url !== target);
    setHistory(next);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {
      /* 忽略 */
    }
  }, [history]);
  const files = result?.files || [];
  const dirCount = files.filter(f => f.is_dir).length;
  const fileCount = files.length - dirCount;
  const visibleFiles = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return files.filter(file => {
      if (fileFilter === 'file' && file.is_dir) return false;
      if (fileFilter === 'dir' && !file.is_dir) return false;
      if (keyword && !String(file.path || '').toLowerCase().includes(keyword)) return false;
      return true;
    });
  }, [files, fileFilter, query]);
  const viewLinks = visibleFiles.filter(f => !f.is_dir && f.url);
  const viewSize = visibleFiles.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
  const explained = useMemo(() => explainError(error), [error]);
  const copyAll = useCallback(async () => {
    const links = viewLinks.map(f => f.url);
    if (links.length === 0) return;
    const ok = await copyText(links.join('\n'));
    if (ok) toast.success('已复制', `${links.length} 条直链`);else toast.error('复制失败', '浏览器拒绝了剪贴板访问，请手动选中复制');
  }, [viewLinks, toast]);
  const copyOne = useCallback(async file => {
    const ok = await copyText(file.url);
    if (ok) toast.success('已复制', file.path);else toast.error('复制失败', '请手动选中复制');
  }, [toast]);
  return /*#__PURE__*/_jsxs("div", {
    className: "page",
    children: [/*#__PURE__*/_jsxs("div", {
      className: "page__header",
      children: [/*#__PURE__*/_jsx("div", {
        className: "page__title",
        children: "\u7F51\u76D8\u76F4\u94FE"
      }), /*#__PURE__*/_jsx("div", {
        className: "page__actions",
        children: /*#__PURE__*/_jsx(Button, {
          icon: "refresh",
          loading: loadingPans,
          onClick: loadPans,
          children: "\u5237\u65B0\u7F51\u76D8\u5217\u8868"
        })
      })]
    }), /*#__PURE__*/_jsx(PageHint, {
      id: "pans",
      icon: "link",
      children: "\u7C98\u8D34\u7F51\u76D8\u5206\u4EAB\u94FE\u63A5\uFF0C\u53D6\u56DE\u53EF\u76F4\u63A5\u4E0B\u8F7D\u7684\u76F4\u94FE\u3002\u51ED\u636E\u6309\u7F51\u76D8\u5206\u5F00\u5B58\uFF1A\u5207\u5230\u54EA\u4E2A\u7F51\u76D8\uFF0C\u5C31\u5E26\u51FA\u54EA\u4E2A\u7F51\u76D8\u7684 Cookie\u3002\u89E3\u6790\u8BB0\u5F55\u7559\u5728\u672C\u9875\uFF0C\u65B9\u4FBF\u56DE\u770B\u3002"
    }), pansError ? /*#__PURE__*/_jsx(ErrorNotice, {
      error: pansError,
      onRetry: () => loadPans().catch(() => {}),
      retryLabel: "\u91CD\u65B0\u52A0\u8F7D"
    }) : null, /*#__PURE__*/_jsxs(Card, {
      title: "\u89E3\u6790\u5206\u4EAB",
      icon: "link",
      subtitle: "\u7C98\u8D34\u94FE\u63A5\uFF0C\u53D6\u56DE\u53EF\u76F4\u63A5\u4E0B\u8F7D\u7684\u76F4\u94FE",
      children: [/*#__PURE__*/_jsxs("div", {
        className: "form-grid",
        children: [/*#__PURE__*/_jsx(Field, {
          label: "\u5206\u4EAB\u94FE\u63A5 *",
          full: true,
          hint: "\u652F\u6301\u5938\u514B / \u84DD\u594F / \u963F\u91CC / \u5929\u7FFC / \u8FC5\u96F7 / \u767E\u5EA6 / 115 / \u4E2D\u56FD\u79FB\u52A8\u4E91\u76D8",
          children: /*#__PURE__*/_jsx("input", {
            className: "input",
            value: url,
            placeholder: "https://pan.quark.cn/s/xxxx",
            onChange: e => setUrl(e.target.value),
            onKeyDown: e => {
              if (e.key === 'Enter' && !resolving) resolve();
            }
          })
        }), /*#__PURE__*/_jsx(Field, {
          label: "\u7F51\u76D8",
          hint: "\u7559\u7A7A\u5219\u81EA\u52A8\u8BC6\u522B",
          children: /*#__PURE__*/_jsxs("select", {
            className: "select",
            value: pan,
            onChange: e => switchPan(e.target.value),
            children: [/*#__PURE__*/_jsx("option", {
              value: "",
              children: "\u81EA\u52A8\u8BC6\u522B"
            }), pans.map(item => /*#__PURE__*/_jsxs("option", {
              value: item.name,
              children: [item.name, item.requiresAuth ? '（需登录）' : '（游客可用）']
            }, item.name))]
          })
        }), /*#__PURE__*/_jsx(Field, {
          label: "\u63D0\u53D6\u7801",
          hint: "\u5206\u4EAB\u8BBE\u6709\u63D0\u53D6\u7801\u65F6\u586B\u5199",
          children: /*#__PURE__*/_jsx("input", {
            className: "input",
            value: pwd,
            placeholder: "\u5982 abcd",
            onChange: e => setPwd(e.target.value)
          })
        })]
      }), selectedPan && !selectedPan.requiresAuth ? /*#__PURE__*/_jsx("div", {
        style: {
          marginTop: 12
        },
        children: /*#__PURE__*/_jsx(Switch, {
          checked: guest,
          onChange: setGuest,
          label: `游客态解析（免凭据；${selectedPan.name} 支持时最快）`
        })
      }) : null, /*#__PURE__*/_jsxs("div", {
        className: "pan-actions",
        children: [/*#__PURE__*/_jsx(Button, {
          variant: "primary",
          icon: "search",
          loading: resolving,
          disabled: !url.trim(),
          onClick: resolve,
          children: "\u89E3\u6790\u76F4\u94FE"
        }), /*#__PURE__*/_jsxs("button", {
          type: "button",
          className: "card__toggle",
          "aria-expanded": credOpen,
          onClick: () => setCredOpen(prev => !prev),
          children: [/*#__PURE__*/_jsx(Icon, {
            name: credOpen ? 'chevronDown' : 'chevronRight',
            size: 13
          }), "\u767B\u5F55\u51ED\u636E\uFF08\u53EF\u9009\uFF09"]
        }), storedActive ? /*#__PURE__*/_jsxs("span", {
          className: "pan-cred-saved",
          children: [/*#__PURE__*/_jsx(Icon, {
            name: "check",
            size: 11
          }), "\u5DF2\u5B58\u300C", slotLabel(activeKey), "\u300D\u7684\u51ED\u636E", /*#__PURE__*/_jsx("button", {
            type: "button",
            className: "pan-cred-saved__x",
            onClick: () => clearSlot(activeKey),
            children: "\u6E05\u9664"
          })]
        }) : null]
      }), credOpen ? /*#__PURE__*/_jsxs("div", {
        className: "pan-cred",
        children: [/*#__PURE__*/_jsxs("div", {
          className: "form-grid",
          children: [/*#__PURE__*/_jsx(Field, {
            label: need.cookie && selectedPan ? 'Cookie（本网盘需要）' : 'Cookie',
            hint: selectedPan ? `只用于「${selectedPan.name}」，切换网盘会自动换成该网盘已存的那份` : '只存在本机浏览器，不会发给后端保存',
            full: true,
            children: /*#__PURE__*/_jsx("input", {
              className: "input",
              value: cookie,
              placeholder: "BDUSS=\u2026; SESSION=\u2026",
              onChange: e => setCookie(e.target.value)
            })
          }), /*#__PURE__*/_jsx(Field, {
            label: need.token && selectedPan ? 'Token（本网盘需要）' : 'Token',
            hint: "\u963F\u91CC\u4E91\u76D8\u7B49\u7528 Bearer token",
            full: true,
            children: /*#__PURE__*/_jsx("input", {
              className: "input",
              value: token,
              placeholder: "eyJhbGciOi\u2026",
              onChange: e => setToken(e.target.value)
            })
          })]
        }), /*#__PURE__*/_jsxs("div", {
          className: "pan-cred__foot",
          children: [/*#__PURE__*/_jsx(Switch, {
            checked: remember,
            onChange: setRemember,
            label: "\u81EA\u52A8\u4FDD\u5B58\u5230\u672C\u673A\uFF08\u6309\u7F51\u76D8\u5206\u522B\u5B58\uFF09"
          }), /*#__PURE__*/_jsx("span", {
            className: "footnote",
            children: Object.keys(slots).length > 0 ? `已存 ${Object.keys(slots).length} 家：${Object.keys(slots).map(slotLabel).join('、')}` : '关闭后不再自动保存；已存的可在下方列表逐项清除'
          })]
        })]
      }) : null, selectedPan?.authHint ? /*#__PURE__*/_jsx("div", {
        style: {
          marginTop: 12
        },
        children: /*#__PURE__*/_jsxs(Notice, {
          tone: selectedPan.requiresAuth ? 'warn' : 'info',
          icon: "alert",
          children: [/*#__PURE__*/_jsx("b", {
            children: selectedPan.name
          }), "\uFF1A", selectedPan.authHint]
        })
      }) : null]
    }), resolving && !result ? /*#__PURE__*/_jsx(Loading, {
      text: "\u6B63\u5728\u89E3\u6790\uFF08\u5217\u76EE\u5F55 + \u9010\u6587\u4EF6\u53D6\u94FE\uFF0C\u5927\u5206\u4EAB\u53EF\u80FD\u8981\u5341\u51E0\u79D2\uFF09\u2026"
    }) : null, error ? /*#__PURE__*/_jsxs(Notice, {
      tone: "error",
      icon: "alert",
      children: [/*#__PURE__*/_jsx("div", {
        className: "pan-err__title",
        children: explained ? explained.title : '解析失败'
      }), /*#__PURE__*/_jsx("div", {
        className: "pan-err__raw",
        children: error
      }), explained ? /*#__PURE__*/_jsx("ul", {
        className: "pan-err__tips",
        children: explained.tips.map(tip => /*#__PURE__*/_jsx("li", {
          children: tip
        }, tip))
      }) : null, /*#__PURE__*/_jsxs("div", {
        className: "pan-err__actions",
        children: [explained?.primary === 'guest' ? /*#__PURE__*/_jsx(Button, {
          size: "sm",
          icon: "user",
          onClick: () => setGuest(true),
          children: "\u5F00\u542F\u6E38\u5BA2\u6001"
        }) : null, explained?.primary === 'cookie' ? /*#__PURE__*/_jsx(Button, {
          size: "sm",
          icon: "shield",
          onClick: () => setCredOpen(true),
          children: "\u53BB\u586B\u767B\u5F55\u51ED\u636E"
        }) : null, /*#__PURE__*/_jsx(Button, {
          size: "sm",
          icon: "refresh",
          loading: resolving,
          onClick: resolve,
          children: "\u91CD\u8BD5"
        })]
      })]
    }) : null, result ? /*#__PURE__*/_jsxs(Card, {
      title: result.title || '（无标题）',
      icon: "link",
      subtitle: `${result.pan} · ${files.length} 项`,
      actions: /*#__PURE__*/_jsx(Button, {
        icon: "copy",
        disabled: viewLinks.length === 0,
        onClick: copyAll,
        children: "\u590D\u5236\u5168\u90E8\u76F4\u94FE"
      }),
      children: [/*#__PURE__*/_jsxs("div", {
        className: "toolbar",
        children: [/*#__PURE__*/_jsx(Tabs, {
          value: fileFilter,
          onChange: setFileFilter,
          options: [{
            value: 'all',
            label: '全部',
            count: files.length
          }, {
            value: 'file',
            label: '文件',
            count: fileCount
          }, {
            value: 'dir',
            label: '目录',
            count: dirCount
          }]
        }), /*#__PURE__*/_jsx(SearchBox, {
          value: query,
          onChange: setQuery,
          placeholder: "\u641C\u7D22\u8DEF\u5F84\u2026",
          width: 240
        }), /*#__PURE__*/_jsx("div", {
          className: "spacer"
        }), /*#__PURE__*/_jsxs("span", {
          className: "footnote",
          children: [visibleFiles.length, " \u9879 \xB7 \u76F4\u94FE ", viewLinks.length, " \u6761", viewSize ? ` · ${formatBytes(viewSize)}` : '']
        })]
      }), files.length === 0 ? /*#__PURE__*/_jsx(EmptyState, {
        title: "\u6CA1\u6709\u89E3\u6790\u51FA\u6587\u4EF6",
        hint: "\u5206\u4EAB\u53EF\u80FD\u5DF2\u5931\u6548\u3001\u4E3A\u7A7A\uFF0C\u6216\u9700\u8981\u767B\u5F55\u6001 / \u63D0\u53D6\u7801\u3002"
      }) : visibleFiles.length === 0 ? /*#__PURE__*/_jsx(EmptyState, {
        title: "\u6CA1\u6709\u5339\u914D\u9879",
        hint: "\u6362\u4E2A\u5173\u952E\u8BCD\uFF0C\u6216\u628A\u7B5B\u9009\u5207\u56DE\u300C\u5168\u90E8\u300D\u3002"
      }) : /*#__PURE__*/_jsxs("table", {
        className: "table",
        children: [/*#__PURE__*/_jsx("thead", {
          children: /*#__PURE__*/_jsxs("tr", {
            children: [/*#__PURE__*/_jsx("th", {
              children: "\u8DEF\u5F84"
            }), /*#__PURE__*/_jsx("th", {
              style: {
                width: 100
              },
              children: "\u5927\u5C0F"
            }), /*#__PURE__*/_jsx("th", {
              children: "\u76F4\u94FE"
            }), /*#__PURE__*/_jsx("th", {
              style: {
                width: 64
              },
              className: "table__actions"
            })]
          })
        }), /*#__PURE__*/_jsx("tbody", {
          children: visibleFiles.map((file, index) => /*#__PURE__*/_jsxs("tr", {
            children: [/*#__PURE__*/_jsxs("td", {
              className: "table__path",
              title: file.path,
              children: [/*#__PURE__*/_jsx(Icon, {
                name: file.is_dir ? 'folder' : 'fileText',
                size: 13
              }), '  ', file.path]
            }), /*#__PURE__*/_jsx("td", {
              className: "tech",
              children: file.is_dir ? '—' : formatBytes(Number(file.size) || 0)
            }), /*#__PURE__*/_jsx("td", {
              className: "tech",
              title: file.url || '',
              children: file.url ? /*#__PURE__*/_jsx("span", {
                className: "pans-url",
                children: file.url
              }) : /*#__PURE__*/_jsx("span", {
                className: "muted",
                children: file.is_dir ? '目录' : '未取到直链'
              })
            }), /*#__PURE__*/_jsx("td", {
              className: "table__actions",
              children: file.url ? /*#__PURE__*/_jsx(Button, {
                size: "sm",
                icon: "copy",
                onClick: () => copyOne(file),
                children: "\u590D\u5236"
              }) : null
            })]
          }, `${file.path}-${index}`))
        })]
      })]
    }) : null, !result && history.length > 0 ? /*#__PURE__*/_jsx(Card, {
      title: "\u6700\u8FD1\u89E3\u6790",
      icon: "clock",
      subtitle: "\u70B9\u4E00\u6761\u5373\u53EF\u91CD\u65B0\u53D6\u94FE\uFF0C\u4E0D\u7528\u518D\u7C98\u4E00\u6B21",
      children: /*#__PURE__*/_jsx("div", {
        className: "pan-hist",
        children: history.map(entry => /*#__PURE__*/_jsxs("div", {
          className: "pan-hist__row",
          children: [/*#__PURE__*/_jsxs("div", {
            className: "pan-hist__main",
            children: [/*#__PURE__*/_jsx("div", {
              className: "pan-hist__title",
              title: entry.title || entry.url,
              children: entry.title || entry.url
            }), /*#__PURE__*/_jsxs("div", {
              className: "pan-hist__meta",
              children: [entry.pan || '自动识别', " \xB7 ", entry.count, " \u9879 \xB7 ", relativeTime(entry.at)]
            })]
          }), /*#__PURE__*/_jsxs("div", {
            className: "pan-hist__actions",
            children: [/*#__PURE__*/_jsx(Button, {
              size: "sm",
              icon: "refresh",
              loading: resolving,
              onClick: () => reparse(entry),
              children: "\u91CD\u65B0\u89E3\u6790"
            }), /*#__PURE__*/_jsx(Button, {
              size: "sm",
              icon: "trash",
              onClick: () => removeHistory(entry.url),
              children: "\u5220\u9664"
            })]
          })]
        }, entry.url))
      })
    }) : null, /*#__PURE__*/_jsxs("div", {
      className: "card",
      children: [/*#__PURE__*/_jsxs("header", {
        className: "card__header",
        children: [/*#__PURE__*/_jsx("div", {
          className: "card__title",
          children: /*#__PURE__*/_jsxs("button", {
            type: "button",
            className: "card__toggle",
            "aria-expanded": supportOpen,
            onClick: () => setSupportOpen(prev => !prev),
            children: [/*#__PURE__*/_jsx(Icon, {
              name: supportOpen ? 'chevronDown' : 'chevronRight',
              size: 13
            }), "\u652F\u6301\u7684\u7F51\u76D8\u4E0E\u51ED\u636E\u8981\u6C42"]
          })
        }), /*#__PURE__*/_jsx("div", {
          className: "card__actions",
          children: /*#__PURE__*/_jsxs("span", {
            className: "footnote",
            children: [pans.length, " \u5BB6 \xB7 \u6E38\u5BA2\u53EF\u7528 ", pans.filter(item => !item.requiresAuth).length, " \u5BB6 \xB7 \u5DF2\u5B58\u51ED\u636E", ' ', Object.keys(slots).length, " \u5BB6"]
          })
        })]
      }), supportOpen ? /*#__PURE__*/_jsx("div", {
        className: "card__body card__body--flush",
        children: pans.length === 0 ? /*#__PURE__*/_jsx(EmptyState, {
          title: "\u6682\u65E0\u7F51\u76D8\u4FE1\u606F",
          hint: "\u70B9\u53F3\u4E0A\u89D2\u5237\u65B0\u91CD\u8BD5\u3002"
        }) : /*#__PURE__*/_jsxs("table", {
          className: "table",
          children: [/*#__PURE__*/_jsx("thead", {
            children: /*#__PURE__*/_jsxs("tr", {
              children: [/*#__PURE__*/_jsx("th", {
                style: {
                  width: 140
                },
                children: "\u7F51\u76D8"
              }), /*#__PURE__*/_jsx("th", {
                style: {
                  width: 84
                },
                children: "\u767B\u5F55\u6001"
              }), /*#__PURE__*/_jsx("th", {
                children: "\u51ED\u636E\u8BF4\u660E"
              }), /*#__PURE__*/_jsx("th", {
                style: {
                  width: 150
                },
                children: "\u672C\u673A\u51ED\u636E"
              })]
            })
          }), /*#__PURE__*/_jsx("tbody", {
            children: pans.map(item => {
              const saved = slots[item.name];
              const hasSaved = Boolean(saved && (saved.cookie || saved.token));
              return /*#__PURE__*/_jsxs("tr", {
                children: [/*#__PURE__*/_jsx("td", {
                  children: item.name
                }), /*#__PURE__*/_jsx("td", {
                  children: /*#__PURE__*/_jsx("span", {
                    className: `status-word ${item.requiresAuth ? 'is-warn' : 'muted'}`,
                    children: item.requiresAuth ? '需登录' : '游客可用'
                  })
                }), /*#__PURE__*/_jsx("td", {
                  className: "muted",
                  children: item.authHint
                }), /*#__PURE__*/_jsx("td", {
                  children: hasSaved ? /*#__PURE__*/_jsxs("span", {
                    className: "pan-cred-cell",
                    children: [/*#__PURE__*/_jsxs("span", {
                      className: "pan-cred-cell__ok",
                      children: [/*#__PURE__*/_jsx(Icon, {
                        name: "check",
                        size: 11
                      }), " \u5DF2\u914D\u7F6E"]
                    }), /*#__PURE__*/_jsx("button", {
                      type: "button",
                      className: "pan-cred-saved__x",
                      onClick: () => clearSlot(item.name),
                      children: "\u6E05\u9664"
                    })]
                  }) : /*#__PURE__*/_jsx("span", {
                    className: "muted",
                    children: item.requiresAuth ? '未配置' : '不需要'
                  })
                })]
              }, item.name);
            })
          })]
        })
      }) : null]
    }), !result && !resolving ? /*#__PURE__*/_jsx(Notice, {
      tone: "info",
      icon: "alert",
      children: "\u53EA\u505A\u89E3\u6790\u3001\u4E0D\u4E0B\u8F7D\u3002\u62FF\u5230\u7684\u76F4\u94FE\u53EF\u4EE5\u8D34\u8FDB aria2 / \u8FC5\u96F7\u7B49\u4E0B\u8F7D\u5668\u8DD1\u6EE1\u5E26\u5BBD\u3002 \u90E8\u5206\u7F51\u76D8\uFF08\u767E\u5EA6\u3001\u8FC5\u96F7\uFF09\u4F1A\u6309\u51FA\u53E3 IP \u505A\u98CE\u63A7\uFF0C\u9047\u5230\u9A8C\u8BC1\u7801\u6216 need verify \u5C5E\u4E8E\u5E73\u53F0\u7B56\u7565\uFF0C\u4E0D\u662F\u89E3\u6790\u5931\u8D25\u3002"
    }) : null]
  });
}
export default PansPage;