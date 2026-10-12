#!/usr/bin/env node
/* ================================================================
 * Memoria 浏览器视觉预览台生成器
 *
 * 从 Obsidian 主窗口 dump 真实 Memoria DOM + 主题 CSS 变量，生成：
 *   preview/theme-vars.css —— styles.css 引用的 var(--…) 取 body 计算值（仅非空）
 *   preview/index.html     —— 链 theme-vars.css → ../styles.css → fix-preview.css，
 *                             内嵌 dump 的 .memoria-root DOM + 演示卡片 + 修复开关
 *
 * 预览页链的就是仓库源 styles.css：改样式 → 浏览器刷新即见。
 * 前提：Obsidian 运行中且主窗口开着 Memoria 视图（否则先自动尝试打开）。
 * 用法：node preview/dump-preview.js
 * ================================================================ */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const stylesCss = fs.readFileSync(path.join(REPO, 'styles.css'), 'utf8');

/* ---------- obsidian eval 封装：eval 侧统一 JSON.stringify 返回，此处反解 ---------- */
function obsidianEval(js) {
  const out = execFileSync('obsidian', ['eval', `code=${js}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // stdout 形如 `=> <JSON>\n`
  });
  return JSON.parse(out.replace(/^=>\s/, '').replace(/\n$/, ''));
}

/* ---------- 0. 确保 Memoria 视图开着 ---------- */
if (!obsidianEval("!!document.querySelector('.memoria-root')")) {
  console.error('主窗口未找到 .memoria-root，尝试打开 Memoria 视图…');
  obsidianEval("app.commands.executeCommandById('memoria:open-memoria')");
  execFileSync('sleep', ['1']);
  if (!obsidianEval("!!document.querySelector('.memoria-root')")) {
    console.error('Memoria 视图仍未打开：请在 Obsidian 手动激活后重跑本脚本');
    process.exit(1);
  }
}

/* ---------- 1. styles.css 全部 var(--…) 变量名 ---------- */
const varNames = [...new Set(
  [...stylesCss.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]),
)].sort();
console.log(`styles.css 引用 CSS 变量 ${varNames.length} 个`);

/* ---------- 2. dump 主窗口：root outerHTML / body class / 主题变量 ---------- */
function dumpRootHtml() {
  const whole = obsidianEval(
    "JSON.stringify(document.querySelector('.memoria-root').outerHTML)"
  );
  // 完整性校验：≥25000 且以 </div> 闭合；否则分块 eval 拼接兜底
  if (whole.length >= 25000 && whole.endsWith('</div>')) {
    console.log(`.memoria-root outerHTML ${whole.length} 字符，完整`);
    return whole;
  }
  console.error(`outerHTML 疑似截断（${whole.length} 字符），改用分块 eval 拼接…`);
  const meta = obsidianEval(
    "JSON.stringify({"
    + "className: document.querySelector('.memoria-root').className,"
    + "style: document.querySelector('.memoria-root').getAttribute('style') || '',"
    + "n: document.querySelector('.memoria-root').children.length})"
  );
  const parts = [];
  for (let i = 0; i < meta.n; i++) {
    parts.push(obsidianEval(
      `JSON.stringify(document.querySelector('.memoria-root').children[${i}].outerHTML)`
    ));
  }
  const styleAttr = meta.style
    ? ` style="${meta.style.replace(/"/g, '&quot;')}"`
    : '';
  const joined = `<div class="${meta.className}"${styleAttr}>${parts.join('')}</div>`;
  console.log(`分块拼接完成（${meta.n} 块，${joined.length} 字符）`);
  return joined;
}

const rootHtml = dumpRootHtml();
const bodyClass = obsidianEval('JSON.stringify(document.body.className)');
const vars = obsidianEval(
  `(function(){const o={};for(const n of ${JSON.stringify(varNames)}){`
  + 'const v=getComputedStyle(document.body).getPropertyValue(n).trim();'
  + 'if(v)o[n]=v;}return JSON.stringify(o);})()'
);
const varEntries = Object.entries(vars);
console.log(`主窗口实测非空变量 ${varEntries.length}/${varNames.length} 个`);
console.log(`body.className: ${bodyClass}`);

/* ---------- 3. 写 preview/theme-vars.css ---------- */
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
fs.writeFileSync(
  path.join(__dirname, 'theme-vars.css'),
  `/* 由 dump-preview.js 生成（${stamp}）—— Obsidian 主窗口实测主题变量，勿手改 */\n`
  + ':root {\n'
  + varEntries.map(([k, v]) => `  ${k}: ${v};`).join('\n')
  + '\n}\n'
);
console.log('已写 preview/theme-vars.css');

/* ---------- 4. 预览页内联脚本（浏览器侧）：克隆 8 张演示卡 + 修复开关 ---------- */
function previewBoot(demoCards) {
  const template = document.querySelector('.memoria-card');
  const host = template.parentNode;
  for (const c of demoCards) {
    const card = template.cloneNode(true);
    card.querySelector('.memoria-card-time').textContent = c.time;
    const body = card.querySelector('.memoria-card-body');
    body.innerHTML = c.html;
    if (c.pinned) card.classList.add('is-pinned');
    if (c.collapsed) body.classList.add('is-collapsed');
    host.appendChild(card);
  }
  const btn = document.createElement('button');
  btn.className = 'preview-toggle-btn';
  btn.textContent = '切灰条修复';
  btn.addEventListener('click', () => {
    const on = document.body.classList.toggle('preview-fixed');
    btn.textContent = on ? '修复: ON' : '切灰条修复';
  });
  document.body.appendChild(btn);
}

const longHtml = Array.from({ length: 24 }, (_, i) =>
  `<p dir="auto">长文第 ${i + 1} 行：演示超过 20 行的折叠截断渐隐（is-collapsed）。</p>`
).join('');
const demoCards = [
  { time: '2026-10-12 08:01', html: '<p dir="auto">短句：一行正文，观察灰条是否压住内容。</p>' },
  { time: '2026-10-12 08:15', html: '<p dir="auto">带标签：读完一篇讲缓存的文章 #灵感 #阅读</p>' },
  { time: '2026-10-12 08:40', html: '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox"> 验证 compact 灰条修复</li><li class="task-list-item"><input type="checkbox" checked> 部署到 NoteBook</li></ul>' },
  { time: '2026-10-12 09:02', collapsed: true, html: longHtml },
  { time: '2026-10-12 09:30', pinned: true, html: '<p dir="auto">置顶卡片：is-pinned 的 accent 混色背景。</p>' },
  { time: '2026-10-12 10:12', html: '<blockquote><p dir="auto">引用块：不要温和地走进那个良夜。</p></blockquote>' },
  { time: '2026-10-12 10:48', html: '<pre><code class="language-ts">const answer = 42;\nconsole.log(answer);</code></pre>' },
  { time: '2026-10-12 11:05', html: '<p dir="auto">第一段。</p><p dir="auto"><br></p><p dir="auto">第二段。</p><p dir="auto"><br></p><p dir="auto">空行多段的末段。</p>' },
];

/* ---------- 5. 写 preview/index.html ---------- */
const html =
  '<!doctype html>\n'
  + '<html lang="zh-CN">\n'
  + '<head>\n'
  + '<meta charset="utf-8">\n'
  + '<title>Memoria 预览台</title>\n'
  + `<!-- 由 dump-preview.js 生成（${stamp}），勿手改；改样式直接编辑 ../styles.css 后刷新 -->\n`
  + `<!-- Obsidian body.className: ${bodyClass} -->\n`
  + '<link rel="stylesheet" href="theme-vars.css">\n'
  + '<link rel="stylesheet" href="../styles.css">\n'
  + '<link rel="stylesheet" href="fix-preview.css">\n'
  + '</head>\n'
  + '<body class="theme-dark">\n'
  + '<div class="preview-viewport">\n'
  + rootHtml + '\n'
  + '</div>\n'
  + `<script>(${previewBoot.toString()})(${JSON.stringify(demoCards)});</script>\n`
  + '</body>\n'
  + '</html>\n';
fs.writeFileSync(path.join(__dirname, 'index.html'), html);
console.log('已写 preview/index.html');
console.log('完成：起服务（/usr/bin/python3 -m http.server 8765）后访问 http://localhost:8765/preview/');
