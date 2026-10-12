# WYSIWYG 输入区设计（Milkdown）

日期：2026-10-12 · 分支：`feat/wysiwyg-composer`（自 dev/focus-mode 切出）

## 背景与目标

用户在 composer 输入 markdown（`> [!quote]`、表格管道符）时看到的是裸源码，体验差。
存卡后的渲染本来就是好的（MarkdownRenderer + callout/blockquote/table 样式齐全），问题只在编辑态。

**目标**：输入区所见即所得——引用/callout、表格、基础格式在打字过程中直接成型。
**非目标（二期）**：#标签胶囊化、粘贴/拖入图片成图块、富文本 HTML 粘贴转换、速记弹窗改造。

## 选型结论

- 引擎：**Milkdown**（ProseMirror 内核，markdown 原生双向，IME/undo/表格质量最佳，bundle +300-500KB）
- 数据格式不变：markdown 字符串仍是唯一真源，存储管线零改动
- WYSIWYG 首版范围（核心三件）：引用/callout、表格、commonmark 基础格式；标签保持纯文本

## 架构

```
memoria-input-card（现有容器不动）
├── 工具栏（# 图片 列表 任务 表格 → 改调 PM 命令）
├── .memoria-wysiwyg-host（新，替换 <textarea> 位置）
│     └── Milkdown / ProseMirror contenteditable
└── 发送/取消/日期选择（不动）
```

新模块 `src/composer/wysiwyg-composer.ts`：`WysiwygComposer` 类，接口
`mount(el) / getValue() / setValue(md) / focus() / destroy() / onChange(cb) / onHeightSync(cb)`。

依赖：`@milkdown/core`、`@milkdown/preset-commonmark`、`@milkdown/plugin-table`、
`@milkdown/plugin-history`、`@milkdown/plugin-clipboard`、`@milkdown/plugin-listener`、`@milkdown/plugin-cursor`。

Callout：扩展 blockquote 的 parse/serialize 规则支持 `> [!type] 标题`，编辑器内成型为
带图标标题的引用块（复用 styles.css 既有 `.callout` 样式）。

## 集成点清单（现绑 textarea 的机制 → 新接法）

| 机制 | 现状 | WYSIWYG 接法 |
| --- | --- | --- |
| 发送 | textarea value → saveMemo | listener onUpdate 同步 md（debounce 150ms），发送走同一管线 |
| 编辑已有笔记 | textarea.value = md | setValue(md)（parser → PM doc） |
| 自动撑高 | scrollHeight 量高 | 内容高度监听，套 is-focused/has-content 动画类；max-height 40vh 内滚 |
| Ctrl+Enter 发送 | sendHotkey 配置 + IME 保护 | PM keymap `Mod-Enter` 发送；WYSIWYG 模式固定 ctrl-enter 契约（sendHotkey="enter" 仅旧路径生效） |
| Enter | 换行（\n 软换行） | 新段落（Notion/flomo 直觉；段落 margin 紧凑 0.3em，视觉等价） |
| TagSuggest | 绑 textarea 事件 | 适配器：PM keydown/input，`#` 检测与替换走 transaction，下拉照常 |
| 工具栏按钮 | insertText markdown 片段 | PM 命令（表格 picker 选行列 → insertTable） |
| 列表智能续行 | 手写正则 | PM list 命令原生处理 |
| 粘贴 | 富文本→md 转换 | 二期；v1 纯 md 文本粘贴开箱即用 |
| 速记弹窗 | 独立 textarea | v1 不动 |

## 数据流

```
输入 → PM doc → Milkdown serializer → markdown 字符串
     → listener onUpdate(debounce) → this.currentMd
     → 发送 → saveMemo（现有管线）
编辑：md → setValue → parser → PM doc
```

## 边界情况

- **IME**：ProseMirror composition 事件处理成熟；验收必测拼音组合不闪不上错字
- **Undo**：plugin-history 管编辑器内 undo；发送清空后重置栈（防 ⌘Z 拉回已发内容）
- **表格**：prosemirror-tables Tab/方向键跨格、行列增删工具条；表头固定第一行
- **空内容**：serialize trim 空 → 发送按钮禁用（复用 has-content）
- **高度**：host max-height 40vh 内滚，FAB 贴底布局（fixed）不变
- **移动端**：v1 桌面 WYSIWYG、移动端默认走旧 textarea（flag 按 Platform 分流），验证后放开
- **降级**：Milkdown init 抛错 → catch → 自动挂回旧 textarea，不白屏
- **开关**：settings.wysiwygInput（默认开），关 = 旧路径原样保留（迭代期保险丝）

## 实施切片（各可独立验证）

1. **骨架**：依赖、WysiwygComposer、替换挂载、md 双向、发送/编辑模式/降级兜底
2. **三件套**：callout node、表格工具、TagSuggest 适配器、工具栏改命令
3. **打磨回归**：编辑器主题（吃 Obsidian CSS 变量）、IME/undo/移动端分流、版本 2.5.0-dev.0 + CHANGELOG

## 视觉迭代工作流

第二 esbuild 入口 `src/composer/preview-entry.ts` → `preview/editor-bundle.js`；
`preview/editor.html` 引 bundle + theme-vars.css + styles.css，浏览器里即活编辑器。
改样式刷新即看；改行为秒级重构建（`npm run build:editor-preview`）。不走 Obsidian 热重载。

## 验收

- 断言：输入 `> 引用` / 插 3×2 表 → DOM 出现成型引用块/table 节点，源码符号不可见；
  发送后存储 md 与 textarea 路径行为等价（同一渲染管线）
- 人工：IME 组合、⌘Z、Tab 跨格、Ctrl+Enter 发送、Enter 新段、FAB/常驻两种布局
- 回归：flag 关 → 旧 textarea 全功能不受影响；速记弹窗、feed 渲染不动

## 风险

- bundle 体积 +300-500KB（fork 可接受，社区上架需再评估）
- Milkdown API 变动较快：锁定具体版本号，不用 `^`
- 移动端触控表格编辑未验证 → v1 分流旧路径
