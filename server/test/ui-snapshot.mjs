/**
 * UI 巡检（开发工具）：用 CDP 打开工作台的每个页面，截图并收集控制台错误。
 *
 * 用法：
 *   node server/test/ui-snapshot.mjs [baseUrl] [outDir]
 * 依赖：本机已安装 Chrome 或 Edge（无需任何 npm 依赖）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..', '..')

const BASE = process.argv[2] || 'http://127.0.0.1:8787'
const OUT_DIR = process.argv[3] || path.join(ROOT, 'docs')
const PORT = 9333

/** 只巡检指定页面（逗号分隔的 name），用于单页复查；不设置时巡检全部页面 */
const ONLY = (process.env.DSM_UI_ONLY || '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean)

/** 服务器页默认展开第一台；巡检改点「Demo Linux（本地假 SSH）」——这台有真实采集数据 */
const PICK_DEMO = `(() => { const row = [...document.querySelectorAll('.server-row')].find((r) => /Demo Linux/.test(r.textContent)); row?.click(); })()`
const demoTab = (index) =>
  `${PICK_DEMO}, (() => { document.querySelectorAll('.server-detail .server-tab')[${index}]?.click(); })()`

const PAGES = [
  { name: 'dashboard', route: '/', waitFor: '.status-strip__item', pre: `(() => {})()`, waitAfterPre: 7000, probe: `{ states: document.querySelectorAll('.status-strip__item').length, runningRows: document.querySelectorAll('.project-row').length, timelineItems: document.querySelectorAll('.timeline__item').length, nav: document.querySelectorAll('.nav__item').length, decorativeCharts: document.querySelectorAll('.spark, .stat-card, .ssh-strip').length, artPanels: document.querySelectorAll('.sidebar__art').length, subtitles: document.querySelectorAll('.page__subtitle').length, loading: /加载中/.test(document.querySelector('.page')?.textContent || '') }` },
  { name: 'projects', route: '/projects', waitFor: '.project-row', probe: `{ groupCards: document.querySelectorAll('.group-card').length, projectCards: document.querySelectorAll('.project-row').length, subServiceToggles: document.querySelectorAll('.project-row__toggle').length, primaryButtons: document.querySelectorAll('.project-row__actions > .btn').length, moreMenus: document.querySelectorAll('.project-row__actions .menu-wrap').length, groupIcons: document.querySelectorAll('.group-card__icon').length, groupBadges: document.querySelectorAll('.group-card__head .badge').length, groupPortPills: document.querySelectorAll('.group-card__ports').length, title: document.querySelector('.page__title')?.textContent }` },
  { name: 'projects-actions', route: '/projects', waitFor: '.project-row', pre: `(() => { document.querySelector('.project-row__actions .menu-wrap button')?.click(); })()`, waitAfterPre: 800, probe: `(() => { const m = document.querySelector('.project-row__actions .menu'); return { menuOpened: Boolean(m), items: [...(m?.querySelectorAll('.menu__item') || [])].map((b) => (b.textContent || '').trim()).filter(Boolean), hasDanger: Boolean(m?.querySelector('.menu__item--danger')) }; })()` },
  { name: 'projects-expanded', route: '/projects', waitFor: '.project-row', pre: `(() => { document.querySelector('.project-row__toggle')?.click(); })()`, waitAfterPre: 900, probe: `(() => ({ subServiceRows: document.querySelectorAll('.group-card__body tbody tr').length, hasSubServiceTable: Boolean(document.querySelector('.group-card__body table')), projectTimeline: Boolean(document.querySelector('.project-timeline')), timelineItems: document.querySelectorAll('.project-timeline .timeline__item').length }))()` },
  { name: 'projects-resources', route: '/projects', waitFor: '.project-row', pre: `(() => { document.querySelectorAll('.project-row__toggle').forEach((btn) => btn.click()); })()`, waitAfterPre: 1800, probe: `(() => { const panel = document.querySelector('.res-panel'); return { resourcePanels: document.querySelectorAll('.res-panel').length, hasPanel: Boolean(panel), hasNoSumNote: /不计入/.test(panel?.textContent || ''), containerRows: document.querySelectorAll('.res-table__row').length, systemRows: document.querySelectorAll('.res-system__row').length, showsUnlinked: /未关联/.test(document.body.textContent), linkButtons: [...document.querySelectorAll('.res-panel button')].filter((b) => /登记关联/.test(b.textContent)).length }; })()` },
  { name: 'projects-loose-collapsed', route: '/projects', waitFor: '.project-row', probe: `(() => { const toggle = document.querySelector('.card__toggle'); const card = toggle?.closest('.card'); return { hasToggle: Boolean(toggle), toggleText: (toggle?.textContent || '').trim(), expanded: toggle?.getAttribute('aria-expanded'), bodyRendered: Boolean(card?.querySelector('.card__body')), serviceRows: card?.querySelectorAll('tbody tr').length ?? 0, pageNodes: document.querySelectorAll('.page *').length, summaryText: (card?.querySelector('.card__actions')?.textContent || '').replace(/\s+/g, ' ').trim() }; })()` },
  { name: 'projects-loose-expanded', route: '/projects', waitFor: '.project-row', pre: `(() => { document.querySelector('.card__toggle')?.click(); })()`, waitAfterPre: 900, probe: `(() => { const card = document.querySelector('.card__toggle')?.closest('.card'); const body = card?.querySelector('.card__body'); return { expanded: document.querySelector('.card__toggle')?.getAttribute('aria-expanded'), groupNames: [...(body?.querySelectorAll('.group-card__name') || [])].map((n) => n.textContent), serviceRows: body?.querySelectorAll('tbody tr').length ?? 0, hasRegisterButton: [...(card?.querySelectorAll('button') || [])].some((b) => /去登记/.test(b.textContent)) }; })()` },
  { name: 'responsive-no-cutoff', route: '/ports', width: 820, waitFor: '.table tbody tr', probe: `(() => {
      // 窄屏下按钮被压扁或被推出可视区 = "只显示一半"（用户反馈的实际症状）
      const content = document.querySelector('.content');
      const cr = content.getBoundingClientRect();
      const squashed = [], offscreen = [];
      for (const b of document.querySelectorAll('.page button')) {
        const r = b.getBoundingClientRect();
        if (r.width === 0) continue;
        if (b.scrollWidth > b.clientWidth + 2) squashed.push((b.textContent||'').trim().slice(0,10));
        if (r.left >= cr.right - 1) offscreen.push((b.textContent||'').trim().slice(0,10));
      }
      const table = document.querySelector('.table');
      return {
        squashed,
        offscreen,
        // table-layout:fixed 后表格宽度应等于容器宽度，而不是按内容撑开
        tableW: Math.round(table?.getBoundingClientRect().width || 0),
        contentW: Math.round(cr.width),
        tableNotOverflowing: Math.round(table?.getBoundingClientRect().width || 0) <= Math.round(cr.width) + 2,
      };
    })()` },
  { name: 'responsive-server-head', route: '/servers', width: 820, waitFor: '.server-row', pre: PICK_DEMO, waitAfterPre: 1800, probe: `(() => {
      const content = document.querySelector('.content');
      const cr = content.getBoundingClientRect();
      const head = document.querySelector('.server-detail__head');
      const btns = [...(head?.querySelectorAll('button') || [])];
      return {
        hasHead: Boolean(head),
        btnCount: btns.length,
        // 详情头部的按钮必须全部留在可视区内
        allVisible: btns.every((b) => {
          const r = b.getBoundingClientRect();
          return r.width === 0 || (r.left >= cr.left - 1 && r.right <= cr.right + 1);
        }),
        offscreen: btns.filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.left >= cr.right - 1; }).length,
        // 窄屏下应隐藏次要信息（主机、状态词、采集时间），只留名称与按钮
        optHidden: [...document.querySelectorAll('.server-detail__opt')].every((el) => getComputedStyle(el).display === 'none'),
      };
    })()` },
  { name: 'wsl', route: '/wsl', waitFor: '.wsl-summary, .empty', probe: `(() => {
      const summary = document.querySelector('.wsl-summary');
      const rows = [...document.querySelectorAll('.page .table tbody tr')];
      return {
        hasSummary: Boolean(summary),
        summaryText: (summary?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        distroCards: document.querySelectorAll('.page .card').length,
        portRows: rows.length,
        hasPortColumn: rows.length === 0 || Boolean(rows[0].querySelector('.table__port')),
        // 必须如实说明"Windows 侧看不到"这件事，否则用户会以为数据缺失
        explainsNamespace: /Windows 侧/.test(document.body.textContent),
        readOnly: /只读查看/.test(document.body.textContent),
        emptyState: document.querySelector('.empty')?.textContent?.slice(0, 30) || null,
      };
    })()` },
  { name: 'vault-locked', route: '/vault', waitFor: '.vault-lock', probe: `(() => ({ locked: Boolean(document.querySelector('.vault-lock')), title: document.querySelector('.vault-lock__title')?.textContent, hint: (document.querySelector('.vault-lock__hint')?.textContent || '').slice(0, 40), hasPasswordInput: Boolean(document.querySelector('.vault-lock__form input[type=password]')), // 锁定时绝不能露出任何条目
    entriesShown: document.querySelectorAll('.vault-item').length, secretInputs: document.querySelectorAll('input[name=password], .vault-item').length }))()` },
  { name: 'vault-mode-choice', route: '/vault', waitFor: '.vault-lock', probe: `(() => {
      const modes = [...document.querySelectorAll('.vault-mode')];
      return {
        // 首次使用必须让用户选，且如实说明两种模式的后果
        isFirstTime: /设置主密码/.test(document.querySelector('.vault-lock__title')?.textContent || ''),
        modeCount: modes.length,
        defaultRecoverable: Boolean(document.querySelector('.vault-mode input[type=radio]:checked')) &&
          [...modes].find((m) => m.querySelector('input')?.checked)?.textContent.includes('本机可找回'),
        mentionsPermanentLoss: /永久无法恢复/.test(document.body.textContent),
        mentionsScope: /同一台电脑/.test(document.body.textContent),
        // 不得声称能恢复主密码本身
        honestAboutLimit: /恢复不了主密码本身|它不是主密码/.test(document.body.textContent),
      };
    })()` },
  { name: 'vault-wrong-password', route: '/vault', waitFor: '.vault-lock', pre: `(() => { const i = document.querySelector('.vault-lock__form input'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(i, 'definitely-wrong'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`, waitAfterPre: 500, pre2: `(() => { [...document.querySelectorAll('.vault-lock__form button')].find((b) => /解锁|创建/.test(b.textContent))?.click(); })()`, waitAfterPre2: 2500, probe: `(() => {
      const firstTime = /设置主密码/.test(document.querySelector('.vault-lock__title')?.textContent || '');
      return {
        firstTime,
        stillLocked: Boolean(document.querySelector('.vault-lock')),
        // 首次创建时任意密码都会建库（这是正确行为）；已有库时错误密码必须被拒
        unlockedAfter: !document.querySelector('.vault-lock'),
        error: document.querySelector('.vault-lock__error')?.textContent || null,
        modeOptions: document.querySelectorAll('.vault-mode').length,
        entriesShown: document.querySelectorAll('.vault-item').length,
      };
    })()` },
  { name: 'servers-auto-monitor', route: '/servers', waitFor: '.am-panel', pre: `(() => { const btn = [...document.querySelectorAll('.am-panel button')].find((b) => /立即采集一轮/.test(b.textContent)); btn?.click(); })()`, waitAfterPre: 2500, probe: `(() => { const panel = document.querySelector('.am-panel'); return { hasPanel: Boolean(panel), hasSwitch: Boolean(panel?.querySelector('.am-switch input')), intervalOptions: panel?.querySelectorAll('.am-interval option').length ?? 0, hasRunButton: [...(panel?.querySelectorAll('button') || [])].some((b) => /立即采集一轮/.test(b.textContent)), showsLastRun: /上次/.test(panel?.textContent || ''), hintDistinguishes: /后端定时器/.test(panel?.textContent || ''), heldNote: /暂停自动重试/.test(document.body.textContent) }; })()` },
  { name: 'servers-trend', route: '/servers', waitFor: '.server-row', pre: PICK_DEMO, waitAfterPre: 2200, probe: `(() => { const trend = document.querySelector('.trend'); return { hasTrend: Boolean(trend), hasHeadline: /历史趋势/.test(trend?.textContent || ''), windowChips: trend?.querySelectorAll('.tab-chip').length ?? 0, trendlines: trend?.querySelectorAll('svg.trendline').length ?? 0, sparkLeak: document.querySelectorAll('.spark').length, statCells: trend?.querySelectorAll('.trendline-stat').length ?? 0, hasStats: /当前|均值/.test(trend?.textContent || ''), emptyOrData: /采样点不足|个采样点/.test(trend?.textContent || '') }; })()` },
  { name: 'servers', route: '/servers', waitFor: '.server-row', pre: PICK_DEMO, waitAfterPre: 1600, probe: `{ rows: document.querySelectorAll('.server-row').length, selected: document.querySelector('.server-row.is-selected')?.textContent.slice(0, 20), detailTabs: document.querySelectorAll('.server-detail .server-tab').length, activeTab: document.querySelector('.server-tab.is-active')?.textContent.trim(), meters: document.querySelectorAll('.meter').length, facts: document.querySelectorAll('.fact').length, readOnlyNote: /只读采集/.test(document.body.textContent), title: document.querySelector('.page__title')?.textContent }` },
  { name: 'servers-apps', route: '/servers', waitFor: '.server-row', pre: demoTab(1), waitAfterPre: 900, probe: `(() => { const body = document.querySelector('.server-tab-body'); return { appRows: body?.querySelectorAll('tbody tr').length ?? 0, empty: Boolean(body?.querySelector('.empty')), hiddenActions: body ? body.querySelectorAll('.row-actions .btn').length : 0 }; })()` },
  { name: 'servers-docker', route: '/servers', waitFor: '.server-row', pre: demoTab(2), waitAfterPre: 1500, probe: `(() => { const body = document.querySelector('.server-tab-body'); return { containerRows: body?.querySelectorAll('tbody tr').length ?? 0, empty: Boolean(body?.querySelector('.empty')), hasReadOnlyNote: /只读采集/.test(document.body.textContent), writeButtons: [...(body?.querySelectorAll('button') || [])].filter((b) => /重启|停止|删除|exec|rm/i.test(b.textContent)).length }; })()` },
  { name: 'servers-ports', route: '/servers', waitFor: '.server-row', pre: demoTab(3), waitAfterPre: 1200, probe: `(() => { const body = document.querySelector('.server-tab-body'); return { auditRows: body?.querySelectorAll('tbody tr').length ?? 0, empty: Boolean(body?.querySelector('.empty')) }; })()` },
  { name: 'servers-logs', route: '/servers', waitFor: '.server-row', pre: demoTab(4), waitAfterPre: 3500, probe: `(() => { const body = document.querySelector('.server-tab-body'); return { logLines: body?.querySelectorAll('.log-panel .log-line, .log-line').length ?? 0, select: body?.querySelector('select')?.value || null, empty: Boolean(body?.querySelector('.empty')) }; })()` },
  { name: 'servers-timeline', route: '/servers', waitFor: '.server-row', pre: demoTab(5), waitAfterPre: 1200, probe: `(() => { const body = document.querySelector('.server-tab-body'); return { timelineItems: body?.querySelectorAll('.timeline__item').length ?? 0, groups: body?.querySelectorAll('.timeline__group').length ?? 0, empty: Boolean(body?.querySelector('.empty')) }; })()` },
  { name: 'discovery', route: '/projects', waitFor: '.group-card', pre: `(() => { const btn = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === '自动发现'); if (btn) btn.click(); })()`, waitAfterPre: 2200, probe: `(() => { const text = document.body.textContent; return { groupCards: document.querySelectorAll('.group-card').length, hasGroupSummary: /项目组/.test(text), hasNoExecuteNote: /不会执行/.test(text), hasAggregateNote: /projectDir/.test(text), subServiceRows: document.querySelectorAll('.group-card__body tbody tr').length }; })()` },
  { name: 'discovery-batch', route: '/projects', waitFor: '.group-card', pre: `(() => { const open = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === '自动发现'); if (open) open.click(); })()`, waitAfterPre: 2200, pre2: `(() => { const batch = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === '批量登记'); if (batch) batch.click(); })()`, waitAfterPre2: 700, probe: `(() => ({ checkboxes: document.querySelectorAll('.group-card__check').length, hasSelectAll: [...document.querySelectorAll('button')].some((b) => /全选待登记/.test(b.textContent)), batchBar: Boolean(document.querySelector('.batch-bar')) }))()` },
  { name: 'ports', route: '/ports', waitFor: '.table tbody tr', probe: `{ rows: document.querySelectorAll('.table tbody tr').length, conflicts: document.querySelectorAll('.notice--warn').length, auditCells: document.querySelectorAll('.table tbody tr .status-word').length, badges: document.querySelectorAll('.table tbody tr .badge').length, title: document.querySelector('.page__title')?.textContent, subtitles: document.querySelectorAll('.page__subtitle').length }` },
  { name: 'logs', route: '/logs', waitFor: '.log-line', probe: `{ lines: document.querySelectorAll('.log-line').length, live: document.querySelector('.toolbar .status-word')?.textContent, badges: document.querySelectorAll('.badge').length, subtitles: document.querySelectorAll('.page__subtitle').length }` },
  { name: 'timeline', route: '/timeline', waitFor: '.timeline__item, .empty', pre: `(() => { const tabs = [...document.querySelectorAll('.tab')]; tabs[0]?.click(); })()`, waitAfterPre: 900, probe: `{ tabs: document.querySelectorAll('.tab').length, selects: document.querySelectorAll('.select').length, items: document.querySelectorAll('.timeline__item').length, dots: document.querySelectorAll('.timeline__dot').length, badges: document.querySelectorAll('.timeline__head .badge').length, empty: Boolean(document.querySelector('.empty')), title: document.querySelector('.page__title')?.textContent }` },
  { name: 'settings', route: '/settings', waitFor: '.kv__key', probe: `{ kv: document.querySelectorAll('.kv__key').length }` },
  // 网盘直链：三个出口（复制 / 推送 aria2 / 下载到本机）。用例只覆盖"不发网络"的部分：
  // 解析要真实分享链接，放进巡检会让这个脚本依赖外部网络。
  { name: 'pans', route: '/pans', waitFor: '.page__title', pre: `(() => { const toggle = [...document.querySelectorAll('.card__toggle')].find((b) => /下载与推送设置/.test(b.textContent)); toggle?.click(); })()`, waitAfterPre: 900, probe: `(() => {
      const text = document.body.textContent;
      const card = [...document.querySelectorAll('.card')].find((c) => /下载与推送设置/.test(c.textContent));
      const inputs = [...(card?.querySelectorAll('.input') || [])];
      return {
        title: document.querySelector('.page__title')?.textContent,
        panCountHint: /支持 [0-9]+ 家/.test(text),
        panOptions: document.querySelectorAll('.select option').length,
        supportsTen: /支持 10 家/.test(text),
        hasTransferCard: Boolean(card),
        expanded: [...document.querySelectorAll('.card__toggle')].find((b) => /下载与推送设置/.test(b.textContent))?.getAttribute('aria-expanded'),
        dirValue: inputs[0]?.value || '',
        rpcValue: inputs[1]?.value || '',
        hasResumeSwitch: /断点续传/.test(card?.textContent || ''),
        hasTestButton: [...(card?.querySelectorAll('button') || [])].some((b) => /测试 aria2/.test(b.textContent)),
      };
    })()` },

  // 结果区三按钮：用 fetch 打桩喂一份假解析结果，不依赖真实分享链接
  { name: 'pans-result', route: '/pans', waitFor: '.page__title', pre: `(() => {
      const fake = { ok: true, data: { pan: '夸克网盘', title: '演示分享', files: [
        { path: '素材/1.png', size: 1024, is_dir: false, url: 'https://cdn.example.com/1.png' },
        { path: '素材', size: 0, is_dir: true, url: '' },
        { path: '素材/2.zip', size: 2048, is_dir: false, url: 'https://cdn.example.com/2.zip' },
      ] } };
      const original = window.fetch;
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf('/api/pans/resolve') >= 0) {
          return Promise.resolve(new Response(JSON.stringify(fake), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return original(input, init);
      };
      const input = document.querySelector('.page input.input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'https://pan.quark.cn/s/demo');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`, waitAfterPre: 400, pre2: `(() => { [...document.querySelectorAll('.page button')].find((b) => /解析直链/.test(b.textContent))?.click(); })()`, waitAfterPre2: 1200, probe: `(() => {
      const texts = [...document.querySelectorAll('.card__actions button')].map((b) => (b.textContent || '').trim());
      const boxes = [...document.querySelectorAll('.pan-check')];
      return {
        title: document.querySelector('.card__title')?.textContent || '',
        threeOutlets: ['复制全部直链', '推送到 aria2', '下载到本机'].every((label) => texts.some((t) => t.indexOf(label) === 0)),
        actions: texts,
        rowButtons: document.querySelectorAll('.pan-row-actions .btn').length,
        rows: document.querySelectorAll('.table tbody tr').length,
        jobCardAbsent: !document.querySelector('.pan-job'),
        // 勾选：默认全选 → 按钮不带（N）后缀；表头复选框勾上；每行一个框
        selectable: boxes.length === 4,
        headerChecked: boxes[0]?.checked === true,
        rowBoxes: boxes.slice(1).every((b) => b.checked === true),
        // 目录行：有子文件就可勾（勾它 = 勾其下全部文件）；这里假数据下有两个
        dirBoxEnabled: boxes[2]?.disabled === false,
        noCountSuffix: texts.every((t) => !/\(\d+\)/.test(t)),
      };
    })()` },
  // 勾选交互：取消一个文件 → 三个按钮立刻带上（N），再全选恢复
  { name: 'pans-select', route: '/pans', waitFor: '.page__title', pre: `(() => {
      const fake = { ok: true, data: { pan: '夸克网盘', title: '演示分享', files: [
        { path: '素材/1.png', size: 1024, is_dir: false, url: 'https://cdn.example.com/1.png' },
        { path: '素材', size: 0, is_dir: true, url: '' },
        { path: '素材/2.zip', size: 2048, is_dir: false, url: 'https://cdn.example.com/2.zip' },
      ] } };
      const original = window.fetch;
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf('/api/pans/resolve') >= 0) {
          return Promise.resolve(new Response(JSON.stringify(fake), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return original(input, init);
      };
      const input = document.querySelector('.page input.input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'https://pan.quark.cn/s/demo');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`, waitAfterPre: 400, pre2: `(() => { [...document.querySelectorAll('.page button')].find((b) => /解析直链/.test(b.textContent))?.click(); })()`, waitAfterPre2: 1200, pre3: `(() => {
      // 取消第一个文件行（第 2 个框：0 是表头全选），顺手记录这一态的按钮文案
      const boxes = [...document.querySelectorAll('.pan-check')];
      boxes[1].click();
      window.__sel1 = {
        texts: [...document.querySelectorAll('.card__actions button')].map((b) => (b.textContent || '').trim()),
        footnote: document.querySelector('.toolbar .footnote')?.textContent || '',
      };
    })()`, waitAfterPre3: 300, pre4: `(() => {
      // 再点表头全选恢复
      [...document.querySelectorAll('.pan-check')][0].click();
      window.__sel2 = [...document.querySelectorAll('.card__actions button')].map((b) => (b.textContent || '').trim());
    })()`, waitAfterPre4: 300, probe: `(() => ({
      // 取消一个 → 三个按钮都带（1），脚注出现「已选」
      uncheckMarked: (window.__sel1?.texts || []).filter((t) => /\(1\)/.test(t)).length,
      footnoteMentionsSelection: /已选/.test(window.__sel1?.footnote || ''),
      // 重新全选 → 后缀全部消失（回到「整条分享」的旧行为）
      reselectClean: (window.__sel2 || []).every((t) => !/\(\d+\)/.test(t)),
    }))()` },
  { name: 'pans-narrow', route: '/pans', width: 820, waitFor: '.page__title', pre: `(() => { const toggle = [...document.querySelectorAll('.card__toggle')].find((b) => /下载与推送设置/.test(b.textContent)); toggle?.click(); })()`, waitAfterPre: 900, probe: `(() => {
      const content = document.querySelector('.content');
      const cr = content.getBoundingClientRect();
      const squashed = [];
      for (const b of document.querySelectorAll('.page button')) {
        const r = b.getBoundingClientRect();
        if (r.width === 0) continue;
        if (b.scrollWidth > b.clientWidth + 2) squashed.push((b.textContent || '').trim().slice(0, 10));
        if (r.left >= cr.right - 1) squashed.push('offscreen:' + (b.textContent || '').trim().slice(0, 10));
      }
      return {
        squashed,
        contentW: Math.round(cr.width),
        cardOverflow: [...document.querySelectorAll('.card')].some((c) => c.getBoundingClientRect().width > cr.width + 2),
      };
    })()` },  {
    // 本地影院：把 mediaserver 接进工作台后的整页托管界面。无论后端影院是否在跑，
    // 页面都会渲染（运行态显示内嵌 iframe + 能力徽标，未运行显示一键启动 + 三步走）。
    name: 'media',
    route: '/media',
    // 等「状态词」（运行中/未运行/启动中）出现，而不是只等标题：media 页首屏要
    // 打一次强制端口扫描（避开缓存），加载比别的页慢一两秒，等标题就探会探到加载态。
    waitFor: '.status-word',
    probe: `(() => {
      const text = document.body.textContent || '';
      const buttons = [...document.querySelectorAll('button')];
      const cards = [...document.querySelectorAll('.card')];
      return {
        title: document.querySelector('.page__title')?.textContent,
        // 导航项高亮：取 .nav__label（不含 hint 后缀）比对，避免「本地影院」被拼接上「海报墙 / 聚合」导致全等失败
        navActive: document.querySelector('.nav__item.is-active .nav__label')?.textContent.trim() === '本地影院',
        hasServiceCard: cards.some((c) => /影院服务/.test(c.textContent)),
        // 运行态有「停止」，未运行有「一键启动」，二者必居其一
        hasStartOrStop: buttons.some((b) => /一键启动/.test(b.textContent) || /停止/.test(b.textContent)),
        hasOpenLibButton: buttons.some((b) => /打开片库/.test(b.textContent)),
        hintMentionsCinema: /本地私人影院/.test(text),
        mentionsAIFix: /AI 修复|逐帧修复|超分/.test(text),
        mentionsAggregate: /聚合搜索/.test(text),
        mentionsOnlyLocal: /本机|只在/.test(text),
      };
    })()` },
  {
    // 本地 Docker：引擎可能就绪（显示容器表）也可能没起（显示「一键拉起」）。
    // 两种状态都必须能渲染，且都要给出可操作的下一步——这条是"不抢功"的前端对应断言：
    // 页面文案里绝不能出现「已为你拉起」这种口气（引擎是用户自己开的时候会说谎）。
    name: 'docker',
    route: '/docker',
    // 这一页首屏要同时取容器列表与引擎状态（桌面版版本号只有引擎接口有），比别的页慢；
    // 等「内容真的出现」而不是只等标题，否则会探到骨架屏（那 15 个渐变块就是骨架 shimmer）。
    waitFor: '.table, .notice--warn, .empty',
    probe: `(() => {
      const text = document.body.textContent || '';
      const buttons = [...document.querySelectorAll('button')];
      const subtitle = document.querySelector('.page__subtitle')?.textContent || '';
      return {
        title: document.querySelector('.page__title')?.textContent,
        navActive: document.querySelector('.nav__item.is-active .nav__label')?.textContent.trim() === 'Docker',
        hasStartButton: buttons.some((b) => /一键拉起 Docker/.test(b.textContent)),
        hasContainerTable: Boolean(document.querySelector('.table')),
        // 引擎没起来时必须解释清楚「连不上」，而不是只留一张空表
        explainsDaemonDown: /连不上 Docker/.test(text),
        // 引擎就绪时副标题带版本号（引擎 x.y.z），双版本信息至少出现引擎版本
        subtitleHasVersion: /引擎 \\d/.test(subtitle),
        // 桌面版是另一套编号（4.x），必须一起显示，否则用户会以为装了两份/版本对不上
        subtitleHasDesktopVersion: /桌面版 \\d/.test(subtitle),
        // 不许抢功：不能出现"已为你拉起"这类没证据的口气
        noUnprovenClaim: !/已为你拉起/.test(text),
        // 长文本列（镜像 / 端口映射）必须走 .cell-clip 截断：table-layout:fixed 下裸文本
        // 会溢出到相邻列，截图里看到过按钮压住端口文字。
        textCellOverflow: [...document.querySelectorAll('.table tbody tr')]
          .filter((row) =>
            [1, 3].some((index) => {
              const cell = row.children[index]
              return cell && cell.scrollWidth > cell.clientWidth + 2
            }),
          ).length,
        // 操作列按钮必须完整留在表格可视区内
        actionsVisible: [...document.querySelectorAll('.table tbody tr')].every((row) => {
          const cell = row.children[4]
          if (!cell) return true
          return [...cell.querySelectorAll('button')].every((b) => {
            const r = b.getBoundingClientRect()
            return r.width === 0 || r.right <= window.innerWidth + 1
          })
        }),
      };
    })()` },
  {
    name: 'project-form',
    route: '/projects',
    waitFor: '.project-row',
    pre: `(() => { const btn = [...document.querySelectorAll('button')].filter((b) => /新增项目/.test(b.textContent)).pop(); btn?.click(); })()`,
    waitAfterPre: 800,
    probe: `{ title: document.querySelector('.modal__title')?.textContent, fields: document.querySelectorAll('.modal .field').length, monoInputs: document.querySelectorAll('.modal .input--tech').length, headerIcons: document.querySelectorAll('.modal__header svg').length }`,
  },
  {
    // 总览：同一件事（未登记服务）不该在横幅和"待处理"清单里各出现一次
    name: 'dashboard-no-duplicate',
    route: '/',
    waitFor: '.todos',
    probe: `(() => {
      const body = document.body.textContent || '';
      const warnBanners = [...document.querySelectorAll('.notice--warn')].filter((n) => /监听服务未登记|未登记/.test(n.textContent || ''));
      const discoveryTodo = [...document.querySelectorAll('.todo')].filter((t) => /监听服务还没登记/.test(t.textContent || ''));
      return {
        states: document.querySelectorAll('.status-strip__item').length,
        warnBanners: warnBanners.length,
        discoveryTodo: discoveryTodo.length,
        todoText: discoveryTodo[0]?.querySelector('.todo__text')?.textContent || null,
        hasDismiss: [...document.querySelectorAll('.todos__dismiss button')].some((b) => /知道了/.test(b.textContent)),
        todoRows: document.querySelectorAll('.todo').length,
      };
    })()`,
  },
  {
    // 服务器「快速填入」：粘贴 ssh 命令后应自动填好对应字段，且不覆盖已填内容
    name: 'server-quick-fill',
    route: '/servers',
    waitFor: '.server-row',
    pre: `(() => { const btn = [...document.querySelectorAll('button')].filter((b) => /新增服务器/.test(b.textContent)).pop(); btn?.click(); })()`,
    waitAfterPre: 800,
    pre2: `(() => {
      const ta = document.querySelector('.quickfill__input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, 'ssh -p 2222 -i ~/.ssh/id_ed25519 root@203.0.113.10');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
    waitAfterPre2: 400,
    pre3: `(() => { [...document.querySelectorAll('.quickfill button')].find((b) => /识别并填入/.test(b.textContent))?.click(); })()`,
    waitAfterPre3: 2000,
    probe: `(() => {
      const val = (label) => {
        const field = [...document.querySelectorAll('.modal .field')].find((f) => (f.querySelector('.field__label')?.textContent || '').includes(label));
        return field?.querySelector('input,select,textarea')?.value ?? null;
      };
      return {
        hasQuickFill: Boolean(document.querySelector('.quickfill')),
        hasApplyButton: [...document.querySelectorAll('.quickfill button')].some((b) => /识别并填入/.test(b.textContent)),
        // 「让 AI 帮我配」：把配置指令复制给 AI，等于 skill 的 UI 入口
        hasAiButton: [...document.querySelectorAll('.quickfill button')].some((b) => /让 AI 帮我配|已复制/.test(b.textContent)),
        hasAiHint: /不会写入密码或私钥正文/.test(document.querySelector('.quickfill')?.textContent || ''),
        showsFilled: /已填入/.test(document.querySelector('.quickfill')?.textContent || ''),
        showsMatched: /识别为/.test(document.querySelector('.quickfill')?.textContent || ''),
        name: val('服务器名称'),
        host: val('IP'),
        port: val('SSH 端口'),
        user: val('登录用户'),
        keyPath: val('私钥路径'),
        authType: val('认证方式'),
        // 不得把明文口令填进任何可见字段
        noPasswordField: !/密码/.test([...document.querySelectorAll('.modal .field__label')].map((l) => l.textContent).filter((t) => /口令/.test(t)).join('') || ''),
      };
    })()`,
  },
  {
    name: 'global-search',
    route: '/',
    waitFor: '.status-strip__item',
    pre: `(() => { const el = document.querySelector('.topbar__search input'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(el, '87'); el.dispatchEvent(new Event('input', { bubbles: true })); el.focus(); })()`,
    // /api/search 会做一次实时端口扫描，实测约 5 秒
    waitAfterPre: 7000,
    probe: `(() => { const pop = document.querySelector('.search-pop'); const cursor = document.querySelector('.search-pop__item.is-cursor'); return { value: document.querySelector('.topbar__search input')?.value, groups: [...(pop?.querySelectorAll('.search-pop__group') || [])].map((g) => g.textContent), items: pop?.querySelectorAll('.search-pop__item').length ?? 0, hasCursor: Boolean(cursor), inlineActions: pop?.querySelectorAll('.search-pop__actions').length ?? 0, empty: pop?.querySelector('.search-pop__empty')?.textContent || null }; })()`,
  },
  {
    // 命令面板：空输入也应给出可用命令（不输入也能用）
    name: 'command-palette',
    route: '/',
    waitFor: '.status-strip__item',
    pre: `(() => { const el = document.querySelector('.topbar__search input'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); el.focus(); el.click(); })()`,
    waitAfterPre: 1200,
    probe: `(() => { const pop = document.querySelector('.search-pop'); const items = [...(pop?.querySelectorAll('.search-pop__item') || [])].map((i) => (i.textContent || '').trim()); return { opened: Boolean(pop), groupTitles: [...(pop?.querySelectorAll('.search-pop__group') || [])].map((g) => g.textContent), items, hasAddProject: items.some((t) => t.includes('新增本地项目')), hasNavPorts: items.some((t) => t.includes('服务端口')), hasDiscover: items.some((t) => t.includes('自动发现')) }; })()`,
  },
]

/** 每页复查：渐变 / 毛玻璃 / 彩色徽标这三类「AI 味」装饰不允许复活 */
const DECOR_PROBE = `(() => {
  const bad = { gradient: 0, blur: 0, badges: 0 }
  for (const el of document.querySelectorAll('body *')) {
    const style = getComputedStyle(el)
    if (/gradient\\(/.test(style.backgroundImage)) bad.gradient += 1
    const blur = style.backdropFilter || style.webkitBackdropFilter
    if (blur && blur !== 'none') bad.blur += 1
  }
  bad.badges = document.querySelectorAll('.badge').length
  return bad
})()`

function findBrowser() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) || null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForEndpoint(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (response.ok) return await response.json()
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) throw new Error('Chrome 调试端口未就绪')
    await sleep(300)
  }
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.events = []
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
        return
      }
      this.events.push(message)
    })
  }

  send(method, params = {}) {
    this.id += 1
    const id = this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`${method} 超时`))
        }
      }, 30000)
    })
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => resolve(ws))
    ws.addEventListener('error', () => reject(new Error(`WebSocket 连接失败：${url}`)))
  })
}

async function main() {
  const browserPath = findBrowser()
  if (!browserPath) throw new Error('没有找到 Chrome / Edge')

  const profile = path.join(os.tmpdir(), `dsm-ui-${Date.now()}`)
  fs.mkdirSync(profile, { recursive: true })
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const chrome = spawn(
    browserPath,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      // 本机若设了 HTTP(S) 代理（开发机常见），Chrome 会把它也套用到 127.0.0.1，
      // 导致导航本地工作台拿到代理的 502。巡检纯本地，直接关掉代理最稳。
      '--no-proxy-server',
      '--disable-extensions',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1600,1120',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  )

  const summary = []
  try {
    const version = await waitForEndpoint()
    const browserWs = new Cdp(await connect(version.webSocketDebuggerUrl))
    const { targetId } = await browserWs.send('Target.createTarget', { url: 'about:blank' })

    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const pageTarget = list.find((item) => item.id === targetId)
    const page = new Cdp(await connect(pageTarget.webSocketDebuggerUrl))

    await page.send('Page.enable')
    await page.send('Runtime.enable')
    await page.send('Log.enable')

    for (const spec of PAGES) {
      if (ONLY.length && !ONLY.includes(spec.name)) continue
      page.events.length = 0
      // 个别用例要专门在窄屏下检查（按钮被裁切/压扁只会在窄屏出现）
      const viewportWidth = spec.width || 1600
      await page.send('Emulation.setDeviceMetricsOverride', { width: viewportWidth, height: 1120, deviceScaleFactor: 1, mobile: false })
      await page.send('Page.navigate', { url: `${BASE}${spec.route}` })

      // 等真实内容出现，而不是固定睡一段时间（端口扫描需要 1-3 秒）
      const deadline = Date.now() + 20000
      let ready = false
      while (Date.now() < deadline) {
        await sleep(300)
        const check = await page.send('Runtime.evaluate', {
          expression: `document.querySelectorAll(${JSON.stringify(spec.waitFor)}).length > 0`,
          returnByValue: true,
        })
        if (check.result?.value === true) {
          ready = true
          break
        }
      }
      await sleep(900)

      // 页面内交互（例如切到某个标签页）后再截图
      if (spec.pre) {
        await page.send('Runtime.evaluate', { expression: spec.pre, returnByValue: true }).catch(() => {})
        await sleep(spec.waitAfterPre || 600)
      }
      if (spec.pre2) {
        await page.send('Runtime.evaluate', { expression: spec.pre2, returnByValue: true }).catch(() => {})
        await sleep(spec.waitAfterPre2 || 600)
      }
      if (spec.pre3) {
        await page.send('Runtime.evaluate', { expression: spec.pre3, returnByValue: true }).catch(() => {})
        await sleep(spec.waitAfterPre3 || 600)
      }

      let probe = null
      try {
        const result = await page.send('Runtime.evaluate', { expression: `(() => (${spec.probe}))()`, returnByValue: true })
        probe = result.result?.value ?? null
      } catch (error) {
        probe = { error: error.message }
      }

      // 每页都复查一遍「AI 味」装饰是否复活：渐变 / 毛玻璃 / 彩色徽标
      let decor = null
      try {
        const result = await page.send('Runtime.evaluate', { expression: DECOR_PROBE, returnByValue: true })
        decor = result.result?.value ?? null
      } catch (error) {
        decor = { error: error.message }
      }

      const shot = await page.send('Page.captureScreenshot', { format: 'png' })
      const file = path.join(OUT_DIR, `ui-${spec.name}.png`)
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))

      const errors = page.events
        .filter((event) => event.method === 'Runtime.exceptionThrown' || (event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error'))
        .map((event) =>
          event.method === 'Runtime.exceptionThrown'
            ? event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text
            : event.params.entry.text,
        )

      summary.push({ page: spec.name, file, ready, probe, decor, consoleErrors: errors.slice(0, 5) })
      console.log(`[ui] ${spec.name.padEnd(10)} ready=${ready} ${JSON.stringify(probe)} decor=${JSON.stringify(decor)} errors=${errors.length}`)
    }
  } finally {
    try {
      chrome.kill()
    } catch {
      /* 忽略 */
    }
    setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500)
  }

  console.log('\nSUMMARY', JSON.stringify(summary, null, 2))
  const leaked = summary.filter((item) => item.decor && (item.decor.gradient || item.decor.blur || item.decor.badges))
  if (leaked.length) {
    console.log('\nDECOR LEAK', JSON.stringify(leaked.map((item) => ({ page: item.page, ...item.decor }))))
    process.exitCode = 3
  }
}

main().catch((error) => {
  console.error('UI 巡检失败：', error.message)
  process.exitCode = 1
})
