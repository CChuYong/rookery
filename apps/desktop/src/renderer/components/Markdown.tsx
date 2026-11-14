import { memo, useEffect, useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { baseName } from "../lib/path.js";
import { cn } from "../lib/cn.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

// T3's hairline table: a bottom rule per row (no grid of borders), numeric-looking cells right-aligned in tabular
// figures. Markdown gives no column-type metadata, so this is a lightweight heuristic over the cell's own text.
function isNumericCell(children: unknown): boolean {
  const text = Array.isArray(children) ? children.join("") : typeof children === "string" ? children : "";
  return /^[-+~]?[$₩]?[\d,]+(\.\d+)?%?$/.test(text.trim());
}
// A short single token (a date like 2026-06, an id, a unit) should never break across lines — the browser would
// otherwise split it at the hyphen in a squeezed column. The table scrolls sideways instead.
function isShortToken(children: unknown): boolean {
  const text = (Array.isArray(children) ? children.join("") : typeof children === "string" ? children : "").trim();
  return text.length > 0 && text.length <= 12 && !/\s/.test(text);
}

// Markdown styles for the dark deck. For block code, pre overrides the inline-chip style of the inner code ([&_code]:...).
const MD_COMPONENTS: Components = {
  p: (p) => <p className="my-1.5 first:mt-0 last:mb-0" {...p} />,
  strong: (p) => <strong className="font-medium text-fg" {...p} />,
  em: (p) => <em className="italic" {...p} />,
  a: (p) => <a className="text-accent underline underline-offset-2 hover:text-accent-hi" target="_blank" rel="noreferrer" {...p} />,
  ul: (p) => <ul className="my-1.5 list-disc space-y-0.5 pl-5 marker:text-muted" {...p} />,
  ol: (p) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5 marker:text-muted" {...p} />,
  li: (p) => <li {...p} />,
  h1: (p) => <h1 className="mb-1.5 mt-3 text-[15px] font-semibold tracking-[-0.01em] first:mt-0" {...p} />,
  h2: (p) => <h2 className="mb-1.5 mt-3 text-[14px] font-medium tracking-[-0.01em] first:mt-0" {...p} />,
  h3: (p) => <h3 className="mb-1 mt-2.5 text-body font-medium first:mt-0" {...p} />,
  blockquote: (p) => <blockquote className="my-1.5 border-l-2 border-line pl-3 text-fg-dim" {...p} />,
  hr: () => <hr className="my-3 border-line" />,
  code: (p) => <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-[0.9em] text-fg [overflow-wrap:anywhere]" {...p} />,
  pre: (p) => (
    <pre className="my-2 overflow-x-auto rounded-lg border border-line bg-ink/70 p-3 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-ui [&_code]:text-fg-dim" {...p} />
  ),
  table: (p) => <div className="my-2 overflow-x-auto"><table className="w-full border-collapse text-ui [&_code]:whitespace-nowrap [&_code]:[overflow-wrap:normal]" {...p} /></div>,
  th: (p) => <th className="whitespace-nowrap border-b border-line px-2 py-1.5 text-left font-medium text-fg-dim" {...p} />,
  td: (p) => <td className={cn("border-b border-line-soft px-2 py-1 [overflow-wrap:normal] [word-break:keep-all]", isNumericCell(p.children) ? "whitespace-nowrap text-right tabular-nums" : isShortToken(p.children) && "whitespace-nowrap")} {...p} />,
};

// User-message bubble variant. The bubble is now a quiet raised surface (bg-raised/text-fg, same tone as the rest
// of the deck), so this mostly mirrors MD_COMPONENTS — the one addition is the @/path mention chip renderer (below).
const MD_BUBBLE_COMPONENTS: Components = {
  p: (p) => <p className="my-1.5 first:mt-0 last:mb-0" {...p} />,
  strong: (p) => <strong className="font-medium text-fg" {...p} />,
  em: (p) => <em className="italic" {...p} />,
  a: (p) => <a className="text-accent underline underline-offset-2 hover:text-accent-hi" target="_blank" rel="noreferrer" {...p} />,
  ul: (p) => <ul className="my-1.5 list-disc space-y-0.5 pl-5 marker:text-muted" {...p} />,
  ol: (p) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5 marker:text-muted" {...p} />,
  li: (p) => <li {...p} />,
  h1: (p) => <h1 className="mb-1.5 mt-3 text-[15px] font-medium tracking-[-0.01em] first:mt-0" {...p} />,
  h2: (p) => <h2 className="mb-1.5 mt-3 text-[14px] font-medium tracking-[-0.01em] first:mt-0" {...p} />,
  h3: (p) => <h3 className="mb-1 mt-2.5 text-body font-medium first:mt-0" {...p} />,
  blockquote: (p) => <blockquote className="my-1.5 border-l-2 border-line pl-3 text-fg-dim" {...p} />,
  hr: () => <hr className="my-3 border-line" />,
  code: (p) => <code className="rounded bg-ink/40 px-1.5 py-0.5 font-mono text-[0.9em] text-fg [overflow-wrap:anywhere]" {...p} />,
  pre: (p) => (
    <pre className="my-2 overflow-x-auto rounded-lg border border-line bg-ink/40 p-3 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-ui [&_code]:text-fg-dim" {...p} />
  ),
  table: (p) => <div className="my-2 overflow-x-auto"><table className="w-full border-collapse text-ui [&_code]:whitespace-nowrap [&_code]:[overflow-wrap:normal]" {...p} /></div>,
  th: (p) => <th className="whitespace-nowrap border-b border-line px-2 py-1.5 text-left font-medium text-fg-dim" {...p} />,
  td: (p) => <td className={cn("border-b border-line-soft px-2 py-1 [overflow-wrap:normal] [word-break:keep-all]", isNumericCell(p.children) ? "whitespace-nowrap text-right tabular-nums" : isShortToken(p.children) && "whitespace-nowrap")} {...p} />,
  // @/path mentions injected by rehypeMentions below → render as the shortened filename chip.
  span: (p: any) =>
    String(p.className ?? "").includes("md-mention")
      ? <span title={p.title} className="mx-px inline-flex items-baseline rounded bg-accent/15 px-1 py-px text-[0.92em] font-medium text-accent-hi">{p.children}</span>
      : <span {...p} />,
};

// The same "@/absolute-path → @filename chip" behavior the old MentionText had, but as a rehype pass so it composes
// with markdown. Hand-walks hast (no unist-util-visit dep — same shape as StreamingMarkdown's plugin below), splitting
// text nodes (outside code/pre) on the mention pattern into text + a span.md-mention that MD_BUBBLE_COMPONENTS renders.
const MENTION = /(^|\s)@(\/\S+)/g;
function rehypeMentions() {
  return (tree: any): void => {
    const walk = (node: any): void => {
      if (!node.children) return;
      const noSplit = node.tagName === "code" || node.tagName === "pre";
      const out: any[] = [];
      for (const child of node.children) {
        if (child.type === "text" && !noSplit && child.value.includes("@/")) {
          const text = String(child.value);
          let last = 0;
          let matched = false;
          MENTION.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = MENTION.exec(text)) !== null) {
            matched = true;
            const chipStart = m.index + m[1].length; // keep the leading whitespace (m[1]) as plain text before the chip
            if (chipStart > last) out.push({ type: "text", value: text.slice(last, chipStart) });
            out.push({ type: "element", tagName: "span", properties: { className: ["md-mention"], title: m[2] }, children: [{ type: "text", value: "@" + baseName(m[2]) }] });
            last = m.index + m[0].length;
          }
          if (!matched) { out.push(child); continue; }
          if (last < text.length) out.push({ type: "text", value: text.slice(last) });
        } else {
          if (child.children) walk(child);
          out.push(child);
        }
      }
      node.children = out;
    };
    walk(tree);
  };
}

// User (human) message body — markdown on the coral bubble. remarkBreaks keeps casual single newlines as line breaks
// (chat expectation; plain markdown would collapse them), rehypeMentions preserves the @file chips.
export const UserMarkdown = memo(function UserMarkdown({ content }: { content: string }): JSX.Element {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={[rehypeMentions]} components={MD_BUBBLE_COMPONENTS}>
      {content}
    </ReactMarkdown>
  );
});

// Codex emits block directives such as `::codex-inline-vis{file="report.html"}` that GFM renders as raw text. Show the
// referenced file as inline code (and drop directives that carry no file) instead of leaking the directive syntax.
const DIRECTIVE_LINE = /^::[\w-]+\{([^}\n]*)\}[ \t]*$/gm;
export function stripDirectives(md: string): string {
  if (!md.includes("::")) return md;
  return md.replace(DIRECTIVE_LINE, (_line, attrs: string) => {
    const file = /\bfile="([^"]+)"/.exec(attrs)?.[1];
    return file ? `\`${file}\`` : "";
  });
}

// memo: skip re-parsing when children are unchanged — prevents re-parsing other (finalized) messages on every streamed token.
export const Markdown = memo(function Markdown({ children }: { children: string }): JSX.Element {
  return (
    <div className="text-prose leading-[1.65]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {stripDirectives(children)}
      </ReactMarkdown>
    </div>
  );
});

// Streaming only: split markdown text into "word+whitespace" tokens and wrap each in a <span>. But only
// "new words" whose index is past the word count as of the previous commit (threshold) get the tok-new class → only those fade. Even if react-markdown
// remounts the spans, old words are tok (no animation) so they don't flicker. Text inside code/pre is not split.
export const StreamingMarkdown = memo(function StreamingMarkdown({ content }: { content: string }): JSX.Element {
  const seen = useRef(0); // word count as of the previous commit
  const count = useRef(0); // word count for this render (scratch — the effect reads it to update seen, StrictMode-safe)
  const plugin = useMemo(
    () => () => (tree: any): void => {
      let idx = 0;
      const threshold = seen.current;
      const walk = (node: any): void => {
        if (!node.children) return;
        const noSplit = node.tagName === "code" || node.tagName === "pre";
        const out: any[] = [];
        for (const child of node.children) {
          if (child.type === "text" && !noSplit) {
            for (const p of String(child.value).split(/(\s+)/)) {
              if (!p) continue;
              if (/^\s+$/.test(p)) { out.push({ type: "text", value: p }); continue; }
              out.push({ type: "element", tagName: "span", properties: { className: idx >= threshold ? ["tok", "tok-new"] : ["tok"] }, children: [{ type: "text", value: p }] });
              idx++;
            }
          } else {
            if (child.children) walk(child);
            out.push(child);
          }
        }
        node.children = out;
      };
      walk(tree);
      count.current = idx;
    },
    [],
  );
  useEffect(() => { seen.current = count.current; }, [content]); // update only after commit (avoid render side effects)
  return (
    <div className="md-streaming text-prose leading-[1.65]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[plugin]} components={MD_COMPONENTS}>
        {stripDirectives(content)}
      </ReactMarkdown>
    </div>
  );
});
