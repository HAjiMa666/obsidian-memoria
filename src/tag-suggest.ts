// ================= 标签联想下拉框 =================
// 监听 textarea 输入，当光标处于 #xxx 这种"未闭合标签"时弹出建议
// 数据来源：Obsidian 整个 Vault 的 metadataCache（含所有笔记的标签）
//          + 当前 Memoria 的标签（已包含在内）

import { App, getAllTags, setIcon } from "obsidian";
import { replaceTextareaRange } from "./textarea-utils";

/** 收集 Vault 全部标签并按使用频率排序（TagSuggest 与 PmTagSuggest 共享） */
export function collectTagCounts(app: App): { name: string; count: number }[] {
  const counter = new Map<string, number>();
  const cache = app.metadataCache;
  const files = app.vault.getMarkdownFiles();
  for (const f of files) {
    const meta = cache.getFileCache(f);
    if (!meta) continue;
    const tags = getAllTags(meta) ?? [];
    for (const tag of tags) {
      // tag 形如 "#知识/学习"，去掉前面的 #
      const name = tag.replace(/^#/, "");
      if (!name) continue;
      counter.set(name, (counter.get(name) ?? 0) + 1);
    }
  }
  return [...counter.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/** 模糊匹配：优先前缀，其次包含与子段（#行 -> #知识/十万个为什么） */
export function matchTags(
  all: { name: string; count: number }[],
  query: string
): string[] {
  if (!query) {
    // 空查询：显示前 8 个最常用
    return all.slice(0, 8).map((x) => x.name);
  }
  const q = query.toLowerCase();
  const prefix: { name: string; count: number }[] = [];
  const contain: { name: string; count: number }[] = [];
  for (const t of all) {
    const lower = t.name.toLowerCase();
    if (lower === q) continue; // 完全相同就不必建议
    if (lower.startsWith(q)) prefix.push(t);
    else if (lower.includes(q)) contain.push(t);
    else {
      const segs = lower.split("/");
      if (segs.some((s) => s.startsWith(q))) contain.push(t);
    }
  }
  return [...prefix, ...contain].slice(0, 8).map((x) => x.name);
}
export class TagSuggest {
  private dropdown: HTMLElement | null = null;
  private items: string[] = [];
  private active = 0;
  private rangeStart = 0; // 触发位置（# 字符所在的索引）

  /** v1.4.11: 标签全扫缓存。
   *   原实现：每按一个键 → 遍历 vault 所有 md → metadataCache.getFileCache → getAllTags。
   *   vault 有 3000+ md 时每次打字都能感觉到输入延迟。
   *   现在：30 秒 TTL 缓存，期间按键直接复用；另外订阅 metadataCache "changed" 事件
   *   让缓存失效，保证新增标签可以在下次打字时看到。 */
  private cachedTags: { name: string; count: number }[] | null = null;
  private cacheTime = 0;
  private static CACHE_TTL_MS = 30_000;
  private metaChangeRef: { unref: () => void } | null = null;

  constructor(private app: App, private textarea: HTMLTextAreaElement) {
    this.textarea.addEventListener("input", this.handleInput);
    this.textarea.addEventListener("keydown", this.handleKeydown, true);
    this.textarea.addEventListener("blur", this.handleBlur);
    this.textarea.addEventListener("scroll", () => this.close());
    // v1.4.11: 监听 metadataCache 变化让缓存失效。
    //   用 app.metadataCache.on("changed", cb) 返回的 ref，在 destroy 时 offref。
    const ref = this.app.metadataCache.on("changed", () => {
      this.cachedTags = null;
    });
    this.metaChangeRef = {
      unref: () => this.app.metadataCache.offref(ref),
    };
  }

  destroy(): void {
    this.textarea.removeEventListener("input", this.handleInput);
    this.textarea.removeEventListener("keydown", this.handleKeydown, true);
    this.textarea.removeEventListener("blur", this.handleBlur);
    if (this.metaChangeRef) {
      this.metaChangeRef.unref();
      this.metaChangeRef = null;
    }
    this.close();
  }

  // -------- 事件 --------

  private handleInput = (): void => {
    const trigger = this.detectTrigger();
    if (!trigger) {
      this.close();
      return;
    }
    this.rangeStart = trigger.start;
    const all = this.collectAllTags();
    this.items = matchTags(all, trigger.query);
    if (this.items.length === 0) {
      this.close();
      return;
    }
    this.active = 0;
    this.render();
  };

  private handleBlur = (): void => {
    // 延迟，给 mousedown 一个机会触发选择
    window.setTimeout(() => this.close(), 150);
  };

  private handleKeydown = (e: KeyboardEvent): void => {
    if (!this.dropdown) return;
    // v2.0.7: IME 组合态下的 Enter/Tab 是"确认候选词"，不是选择下拉项
    //   否则中文输入法打 #xxx 时按 Enter 上屏拼音会被联想面板吞掉。
    //   和 view.ts 主 keydown 的修复思路完全一致。
    if (e.isComposing || (e as KeyboardEvent & { keyCode?: number }).keyCode === 229) {
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.active = (this.active + 1) % this.items.length;
      this.refreshActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.active = (this.active - 1 + this.items.length) % this.items.length;
      this.refreshActive();
    } else if (e.key === "Enter" || e.key === "Tab") {
      // Ctrl+Enter 是发送，让它通过；其他 Enter/Tab 拦截做选择
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      this.applySelected();
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    }
  };

  // -------- 触发检测 --------

  /**
   * 检测光标位置是否处于 "#xxx" 这种待补全状态
   * 返回 { start: # 字符位置, query: # 后到光标的字符 }
   */
  private detectTrigger(): { start: number; query: string } | null {
    const pos = this.textarea.selectionStart ?? 0;
    const text = this.textarea.value;
    // 向前找最近的 # 字符
    let i = pos - 1;
    while (i >= 0) {
      const ch = text[i];
      if (ch === "#") {
        // # 前面必须是行首/空格/换行/中文标点之类的边界
        const prev = i === 0 ? " " : text[i - 1];
        if (/[\s\n\r,，。.!?！？（(]/.test(prev) || i === 0) {
          const query = text.slice(i + 1, pos);
          // query 必须是合法标签字符
          if (/^[A-Za-z0-9_\u4e00-\u9fff/]*$/.test(query)) {
            return { start: i, query };
          }
        }
        return null;
      }
      // 遇到空白/换行就停
      if (/[\s\n\r]/.test(ch)) return null;
      // 遇到非标签字符也停
      if (!/[A-Za-z0-9_\u4e00-\u9fff/]/.test(ch)) return null;
      i--;
    }
    return null;
  }

  // -------- 数据 --------

  /** 收集 Vault 里所有标签，按使用频率排序
   *  v1.4.11: 30 秒 TTL 缓存 + metadataCache changed 事件失效。
   *  v2.5.0-dev.2: 扫描与匹配逻辑提取为模块级 collectTagCounts / matchTags
   *  （PmTagSuggest 共享），类内只保留缓存语义。 */
  private collectAllTags(): { name: string; count: number }[] {
    if (
      this.cachedTags &&
      Date.now() - this.cacheTime < TagSuggest.CACHE_TTL_MS
    ) {
      return this.cachedTags;
    }
    const result = collectTagCounts(this.app);
    this.cachedTags = result;
    this.cacheTime = Date.now();
    return result;
  }


  // -------- UI --------

  private render(): void {
    if (!this.dropdown) {
      this.dropdown = activeDocument.body.createDiv({ cls: "memoria-tag-suggest" });
      // 阻止点击下拉框时 textarea 的 blur 抢先关闭
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
    // 滚动到可见
    const activeEl = items[this.active] as HTMLElement | undefined;
    if (activeEl) {
      activeEl.scrollIntoView({ block: "nearest" });
    }
  }

  /** 把下拉定位到 textarea 当前光标下方 */
  private position(): void {
    if (!this.dropdown) return;
    const rect = this.textarea.getBoundingClientRect();
    // 简化：定位到 textarea 左下，避免计算光标坐标
    const top = rect.bottom + 4;
    const left = rect.left + 4;
    this.dropdown.style.top = `${top}px`;
    this.dropdown.style.left = `${left}px`;
    this.dropdown.style.minWidth = `${Math.min(rect.width, 280)}px`;
  }

  private applySelected(): void {
    if (!this.dropdown || !this.items.length) return;
    const chosen = this.items[this.active];
    const pos = this.textarea.selectionStart ?? 0;
    // 替换 [rangeStart, pos) 为 #chosen + 空格
    // v2.1.0-iter8: 用 replaceTextareaRange 保留 undo（之前 Ctrl+Z 不工作就是这里搞的）
    const insert = `#${chosen} `;
    replaceTextareaRange(this.textarea, this.rangeStart, pos, insert);
    this.textarea.focus();
    this.close();
  }

  private close(): void {
    if (this.dropdown) {
      this.dropdown.remove();
      this.dropdown = null;
    }
    this.items = [];
    this.active = 0;
  }
}
