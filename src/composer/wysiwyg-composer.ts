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
  rootCtx,
} from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { commonmark } from "@milkdown/preset-commonmark";
import { history } from "@milkdown/plugin-history";
import { clipboard } from "@milkdown/plugin-clipboard";
import { cursor } from "@milkdown/plugin-cursor";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { getMarkdown, replaceAll } from "@milkdown/utils";

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

  async destroy(): Promise<void> {
    await this.editor?.destroy();
    this.editor = null;
  }
}
