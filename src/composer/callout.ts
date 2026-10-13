/**
 * Obsidian callout 语法支持（编辑器侧）
 * 设计文档：docs/plans/2026-10-12-wysiwyg-composer-design.md（切片 2）
 *
 * 目标语法：`> [!type] 标题` + 后续引用行 —— 在编辑器里成型为
 * div[data-callout=type]，首个子段落即标题（可编辑），其余为正文。
 * 序列化回 markdown 时还原成标准 callout 引用块（与 Obsidian 读写兼容，
 * 存储格式与 textarea 路径完全一致）。
 *
 * 组成：
 * 1. calloutRemarkPlugin —— parse 期把 "> [!type]" 形态的 blockquote
 *    mdast 改写为 type="callout" 的自定义节点（标题前缀剥到 calloutType）
 * 2. calloutSchema      —— PM 节点定义（div[data-callout]）+ 双向序列化
 * 3. calloutInputRule   —— 在 blockquote 内打 "[!quote] " 即时转 callout
 *
 * ⚠️ group: "block" 不可省——缺它节点不属于 block 组，放不进任何
 *    content: "block+" 容器（doc/blockquote），createAndFill 静默失败
 *    （milkdown closeNode 吞错），表现为"内容消失、输入框变高但空白"。
 */
import { $inputRule, $nodeSchema, $remark } from "@milkdown/utils";
import { InputRule } from "@milkdown/prose/inputrules";
import { TextSelection } from "@milkdown/prose/state";
import type { MilkdownPlugin } from "@milkdown/ctx";
import { visit } from "unist-util-visit";

/** 最小 mdast 节点形状（避免引入 @types/mdast 依赖） */
interface MdNode {
  type: string;
  children?: MdNode[];
  value?: string;
  calloutType?: string;
  [key: string]: unknown;
}

const CALLOUT_PREFIX_RE = /^\[!([a-zA-Z-]+)\][ \t]*(.*)$/;

/** parse 期改写：blockquote([!type] 标题 …) → callout(type, children) */
const calloutRemarkPlugin = $remark("remarkCallout", () => () => {
  // Transformer 的 tree 是 remark 的 Root；这里只需要窄视图，参数放 unknown
  return (tree: unknown) => {
    const walk = visit as unknown as (
      t: unknown,
      test: string,
      visitor: (node: MdNode) => void
    ) => void;
    walk(tree, "blockquote", (node) => {
      const first = node.children?.[0];
      if (!first || first.type !== "paragraph") return;
      const firstText = first.children?.[0];
      if (!firstText || firstText.type !== "text") return;
      const m = CALLOUT_PREFIX_RE.exec(firstText.value ?? "");
      if (!m) return;
      const [, type, title] = m;
      firstText.value = title;
      // 标题剥空后首段只剩前缀 → 整段删除，标题由首个正文段承担
      if (title === "" && (first.children?.length ?? 0) === 1) {
        node.children?.shift();
      }
      node.type = "callout";
      node.calloutType = type.toLowerCase();
    });
  };
});

/** 运行时窄化：读 remark 改写时挂上的 calloutType 字段（缺省 note） */
function readCalloutType(node: object): string {
  if ("calloutType" in node && typeof node.calloutType === "string") {
    return node.calloutType;
  }
  return "note";
}

const calloutSchema = $nodeSchema("callout", () => ({
  content: "block+",
  group: "block",
  defining: true,
  attrs: {
    type: { default: "note" },
  },
  parseDOM: [
    {
      tag: "div[data-callout]",
      getAttrs: (dom) => ({
        type: dom.getAttribute("data-callout") ?? "note",
      }),
    },
  ],
  toDOM: (node) => ["div", { "data-callout": String(node.attrs.type) }, 0],
  parseMarkdown: {
    match: (node) => node.type === "callout",
    runner: (state, node, type) => {
      state.openNode(type, { type: readCalloutType(node) });
      state.next((node as MdNode).children);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "callout",
    runner: (state, node) => {
      // 还原为 blockquote：首子块（标题段）重写为 "[!type] 标题" 文本
      const first = node.content.firstChild;
      const title =
        first && first.type.name === "paragraph" ? first.textContent : "";
      state.openNode("blockquote");
      state.openNode("paragraph");
      // addText 未在类型声明里（运行时存在），用等价 addNode("text", …)
      state.addNode(
        "text",
        undefined,
        `[!${node.attrs.type}]${title ? " " + title : ""}`.trimEnd()
      );
      state.closeNode();
      state.next(first ? node.content.cut(first.nodeSize) : node.content);
      state.closeNode();
    },
  },
}));

/** blockquote 内输入 "[!quote] " 即时成型（前缀匹配后转节点） */
const calloutInputRule = $inputRule(
  () =>
    new InputRule(
      /^\[!([a-zA-Z-]+)\]\s$/,
      (state, match, start, end) => {
        const $start = state.doc.resolve(start);
        for (let d = $start.depth; d > 0; d--) {
          const ancestor = $start.node(d);
          if (ancestor.type.name !== "blockquote") continue;
          const calloutType = state.schema.nodes.callout;
          if (!calloutType) return null;
          const pos = $start.before(d);
          const tr = state.tr;
          // 删掉 "[!quote] " 文本，再把整个 blockquote 原位替换为 callout
          tr.delete(start, end);
          const bq = tr.doc.nodeAt(tr.mapping.map(pos));
          if (!bq) return null;
          tr.replaceWith(
            tr.mapping.map(pos),
            tr.mapping.map(pos + bq.nodeSize),
            calloutType.create({ type: match[1].toLowerCase() }, bq.content)
          );
          tr.setSelection(
            TextSelection.near(tr.doc.resolve(tr.mapping.map(start)))
          );
          return tr;
        }
        return null;
      }
    )
);

/** 挂到 Editor.use() 的组合导出（$remark 返回 [options, plugin] 元组，flat 展平） */
export const callout: MilkdownPlugin[] = [
  calloutSchema,
  calloutRemarkPlugin,
  calloutInputRule,
].flat(2);

export { calloutSchema, calloutRemarkPlugin, calloutInputRule };
