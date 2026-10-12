/**
 * WYSIWYG 输入区（Milkdown / ProseMirror）
 * 设计文档：docs/plans/2026-10-12-wysiwyg-composer-design.md
 *
 * 切片 1（骨架）策略：textarea 保留在 DOM 但隐藏，编辑器 markdown 通过
 * listener 实时镜像回 textarea.value —— 草稿 / 提交 / 编辑模式等既有管线
 * 读 inputEl.value 的行为完全不变。
 *
 * 快捷键：Ctrl/Cmd+Enter 发送由 view.ts 在 contentEl capture 阶段的统一
 * 监听处理（activeElement 在视图内即命中，contenteditable 也不例外）；
 * Enter = 新段落（Notion/flomo 直觉）。WYSIWYG 模式下 sendHotkey="enter"
 * 不生效（Enter 已被段落语义占用，见 shouldSendOnKeydown 的守卫）。
 */
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  parserCtx,
  rootCtx,
} from "@milkdown/core";
import { gfm, insertTableCommand } from "@milkdown/preset-gfm";
import {
  commonmark,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
} from "@milkdown/preset-commonmark";
import { history } from "@milkdown/plugin-history";
import { clipboard } from "@milkdown/plugin-clipboard";
import { cursor } from "@milkdown/plugin-cursor";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { getMarkdown, replaceAll } from "@milkdown/utils";
import { Slice } from "@milkdown/prose/model";

export interface WysiwygCallbacks {
  /** markdown 内容变化（每次编辑器事务后触发，含 setValue） */
  onMarkdown(md: string): void;
  onFocus(): void;
  onBlur(): void;
}

export class WysiwygComposer {
  private editor: Editor | null = null;
  /** mount 完成前收到 setValue 时暂存，mount 后应用。
   *  buildInputCard 是同步调用，而 onOpen 的草稿恢复 / enterEditMode 的
   *  内容装载可能在异步 mount 完成前发生。 */
  private pendingMd: string | null = null;

  constructor(
    private host: HTMLElement,
    private cb: WysiwygCallbacks
  ) {}

  /** 异步初始化。失败时抛错，由调用方降级回旧 textarea。 */
  async mount(initialMd: string): Promise<void> {
    const editor = await new Editor()
      .config((ctx) => {
        ctx.set(rootCtx, this.host);
        ctx.set(defaultValueCtx, initialMd);
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          this.cb.onMarkdown(markdown);
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(clipboard)
      .use(cursor)
      .use(listener)
      .create();
    this.editor = editor;
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    // focus/blur 不冒泡，直接绑在 contenteditable 上
    view.dom.addEventListener("focus", () => this.cb.onFocus());
    view.dom.addEventListener("blur", () => this.cb.onBlur());
    if (this.pendingMd !== null) {
      const md = this.pendingMd;
      this.pendingMd = null;
      this.setValue(md);
    }
  }

  getValue(): string {
    return this.editor?.action(getMarkdown()) ?? "";
  }

  /** 替换全部内容。flush=true 同时重建 EditorState 重置 undo 栈
   *  （发送清空 / 切换编辑对象后，⌘Z 不应把旧内容拉回来）。 */
  setValue(md: string, flush = true): void {
    if (!this.editor) {
      this.pendingMd = md;
      return;
    }
    this.editor.action(replaceAll(md, flush));
  }

  focus(): void {
    this.editor?.action((ctx) => ctx.get(editorViewCtx).focus());
  }

  blur(): void {
    this.editor?.action((ctx) => {
      ctx.get(editorViewCtx).dom.blur();
    });
  }

  /* ---------- 工具栏命令（view.ts 双路径按钮的 WYSIWYG 分支） ---------- */

  /** 在光标处插入纯文本（#标签、图片 wikilink 等） */
  insertTextAtCursor(text: string): void {
    this.editor?.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { from, to } = view.state.selection;
      view.dispatch(view.state.tr.insertText(text, from, to));
    });
    this.focus();
  }

  /** 在光标处插入一段 markdown（解析为节点后替换选区） */
  insertMarkdown(md: string): void {
    this.editor?.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parsed = ctx.get(parserCtx)(md);
      if (!parsed || typeof parsed === "string") return;
      view.dispatch(
        view.state.tr.replaceSelection(new Slice(parsed.content, 0, 0)).scrollIntoView()
      );
    });
    this.focus();
  }

  /** 当前行/选区转无序列表 */
  wrapInBulletList(): void {
    // $Command.run 在 mount 后已绑定 ctx（注册期赋值），直接调用
    wrapInBulletListCommand.run();
    this.focus();
  }

  /** 当前行/选区转有序列表 */
  wrapInOrderedList(): void {
    wrapInOrderedListCommand.run();
    this.focus();
  }

  /** 当前行转任务项（普通段落 → 任务；已是任务 → 退回普通列表项） */
  toggleTaskList(): void {
    // 先保证处于列表中（已是列表时 wrapIn 幂等），再翻转 list_item 的 checked
    wrapInBulletListCommand.run();
    this.editor?.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const $pos = state.doc.resolve(state.selection.from);
      for (let d = $pos.depth; d > 0; d--) {
        const node = $pos.node(d);
        if (node.type.name === "list_item") {
          view.dispatch(
            state.tr.setNodeMarkup($pos.before(d), undefined, {
              ...node.attrs,
              checked: node.attrs.checked == null ? false : null,
            })
          );
          break;
        }
      }
    });
    this.focus();
  }

  /** 插入 rows × cols 表格（gfm 原生命令，带表头行） */
  insertTable(rows: number, cols: number): void {
    insertTableCommand.run({ row: rows, col: cols });
    this.focus();
  }

  async destroy(): Promise<void> {
    await this.editor?.destroy();
    this.editor = null;
  }
}
