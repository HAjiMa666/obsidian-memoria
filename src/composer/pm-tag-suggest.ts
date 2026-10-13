/**
 * WYSIWYG 编辑器的 #标签联想（PmTagSuggest）
 *
 * 与 textarea 版 TagSuggest 行为对齐：光标处于 "#xxx" 未闭合标签时弹
 * 下拉（复用 .memoria-tag-suggest 样式与 collectTagCounts/matchTags 数据
 * 源）；Enter/Tab 选中，Arrow 导航，Esc 关闭，Ctrl+Enter 放行给发送。
 * 替换走 PM 事务（insertText），undo 可撤销。
 *
 * 与 textarea 版的差异：
 * - 触发检测读 ProseMirror doc（光标所在 textblock 的光标前文本），
 *   替换范围用 doc 位置而非字符串 offset
 * - 下拉定位用 view.coordsAtPos 贴光标，而不是容器左下角
 */
import { App, setIcon } from "obsidian";
import { editorViewCtx } from "@milkdown/core";
import { collectTagCounts, matchTags } from "../tag-suggest";
import type { WysiwygComposer } from "./wysiwyg-composer";

interface TagRange {
  query: string;
  /** doc 内 "#query" 的起始位置 */
  from: number;
  /** 光标位置 */
  to: number;
}

export class PmTagSuggest {
  private dropdown: HTMLElement | null = null;
  private items: string[] = [];
  private active = 0;
  private range: TagRange | null = null;

  private cachedTags: { name: string; count: number }[] | null = null;
  private cacheTime = 0;
  private static CACHE_TTL_MS = 30_000;
  private metaChangeRef: { unref: () => void } | null = null;
  private boundDom: HTMLElement | null = null;

  constructor(
    private app: App,
    private composer: WysiwygComposer
  ) {
    const ref = this.app.metadataCache.on("changed", () => {
      this.cachedTags = null;
    });
    this.metaChangeRef = {
      unref: () => this.app.metadataCache.offref(ref),
    };
  }

  /** 绑定到当前 view.dom（热重载复活后 view 会换新 dom，重复 bind 自动解旧） */
  bind(): void {
    const dom = this.composer
      .getEditor()
      ?.action((ctx) => ctx.get(editorViewCtx).dom);
    this.unbind();
    if (!dom) return;
    this.boundDom = dom;
    dom.addEventListener("input", this.handleInput);
    dom.addEventListener("keydown", this.handleKeydown, true);
    dom.addEventListener("blur", this.handleBlur);
    dom.addEventListener("scroll", this.closeSoon, { passive: true });
  }

  unbind(): void {
    if (!this.boundDom) return;
    this.boundDom.removeEventListener("input", this.handleInput);
    this.boundDom.removeEventListener("keydown", this.handleKeydown, true);
    this.boundDom.removeEventListener("blur", this.handleBlur);
    this.boundDom.removeEventListener("scroll", this.closeSoon);
    this.boundDom = null;
    this.close();
  }

  destroy(): void {
    this.unbind();
    if (this.metaChangeRef) {
      this.metaChangeRef.unref();
      this.metaChangeRef = null;
    }
  }

  // -------- 事件 --------

  private handleInput = (): void => {
    // PM 的 DOMObserver 在输入后的下一帧才把 DOM 变化（含选区）同步进
    // state——input 事件里立即读 selection 拿到的是旧值，延迟一帧再检测
    window.requestAnimationFrame(() => this.detectAndSuggest());
  }

  private detectAndSuggest(): void {
    const trigger = this.detectTrigger();
    if (!trigger) {
      this.close();
      return;
    }
    this.range = trigger;
    const all = this.collectAllTags();
    this.items = matchTags(all, trigger.query);
    if (this.items.length === 0) {
      this.close();
      return;
    }
    this.active = 0;
    this.render();
  }

  private handleBlur = (): void => {
    // 延迟，给 mousedown 一个机会触发选择
    window.setTimeout(() => this.close(), 150);
  };

  /** 滚动时下拉会脱离光标，直接关掉（TagSuggest 同款行为） */
  private closeSoon = (): void => {
    this.close();
  };

  private handleKeydown = (e: KeyboardEvent): void => {
    if (!this.dropdown) return;
    // IME 组合态下的 Enter/Tab 是"确认候选词"，不是选择下拉项
    if (e.isComposing || (e as KeyboardEvent & { keyCode?: number }).keyCode === 229) {
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      this.active = (this.active + 1) % this.items.length;
      this.refreshActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      this.active = (this.active - 1 + this.items.length) % this.items.length;
      this.refreshActive();
    } else if (e.key === "Enter" || e.key === "Tab") {
      // Ctrl/Cmd+Enter 是发送，让它通过
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      this.applySelected();
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    }
  };

  // -------- 触发检测（ProseMirror doc） --------

  private detectTrigger(): TagRange | null {
    return (
      this.composer.getEditor()?.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state } = view;
        if (!state.selection.empty) return null;
        const $from = state.selection.$from;
        const textBefore = $from.parent.textBetween(
          0,
          $from.parentOffset,
          "\n",
          "\n"
        );
        const m = /(?:^|\s)#([^\s#]*)$/.exec(textBefore);
        if (!m) return null;
        // 替换范围只覆盖 "#query"（不含前导空格）；跨节点时 insertText 会
        // 抛错，由 applySelected 的 try/catch 兜底放弃本次替换
        return {
          query: m[1],
          from: $from.pos - (m[1].length + 1),
          to: $from.pos,
        };
      }) ?? null
    );
  }

  // -------- 数据 --------

  private collectAllTags(): { name: string; count: number }[] {
    if (
      this.cachedTags &&
      Date.now() - this.cacheTime < PmTagSuggest.CACHE_TTL_MS
    ) {
      return this.cachedTags;
    }
    const result = collectTagCounts(this.app);
    this.cachedTags = result;
    this.cacheTime = Date.now();
    return result;
  }

  // -------- UI（复用 .memoria-tag-suggest 样式） --------

  private render(): void {
    if (!this.dropdown) {
      this.dropdown = activeDocument.body.createDiv({ cls: "memoria-tag-suggest" });
      // 阻止点击下拉框时编辑器的 blur 抢先关闭
      this.dropdown.addEventListener("mousedown", (e) => e.preventDefault());
    }
    this.dropdown.empty();
    this.items.forEach((name, i) => {
      const item = this.dropdown!.createDiv({
        cls:
          "memoria-tag-suggest-item" + (i === this.active ? " active" : ""),
      });
      const icon = item.createSpan({ cls: "memoria-tag-suggest-icon" });
      setIcon(icon, "hash");
      item.createSpan({ cls: "memoria-tag-suggest-name", text: name });
      item.addEventListener("click", () => {
        this.active = i;
        this.applySelected();
      });
    });
    this.position();
  }

  private refreshActive(): void {
    if (!this.dropdown) return;
    const items = this.dropdown.querySelectorAll(".memoria-tag-suggest-item");
    items.forEach((el, i) => {
      el.toggleClass("active", i === this.active);
    });
    const activeEl = items[this.active] as HTMLElement | undefined;
    if (activeEl) {
      activeEl.scrollIntoView({ block: "nearest" });
    }
  }

  /** 下拉贴在光标下方（coordsAtPos），比 textarea 版的容器左下角更准 */
  private position(): void {
    if (!this.dropdown || !this.range) return;
    const coords = this.composer.getEditor()?.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      return view.coordsAtPos(this.range!.to);
    });
    if (!coords) return;
    this.dropdown.style.top = `${coords.bottom + 4}px`;
    this.dropdown.style.left = `${coords.left}px`;
  }

  private applySelected(): void {
    if (!this.dropdown || !this.items.length || !this.range) return;
    const chosen = this.items[this.active];
    const { from, to } = this.range;
    try {
      this.composer.getEditor()?.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        view.dispatch(view.state.tr.insertText(`#${chosen} `, from, to));
        view.focus();
      });
    } catch {
      // 光标处的 "#query" 跨了 inline 节点边界，放弃替换（不吞用户输入）
    }
    this.close();
  }

  private close(): void {
    if (this.dropdown) {
      this.dropdown.remove();
      this.dropdown = null;
    }
    this.items = [];
    this.active = 0;
    this.range = null;
  }
}
