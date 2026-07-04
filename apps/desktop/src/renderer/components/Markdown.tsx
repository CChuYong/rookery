import { memo, useEffect, useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { baseName } from "../lib/path.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Markdown styles for the dark deck. For block code, pre overrides the inline-chip style of the inner code ([&_code]:...).
const MD_COMPONENTS: Components = {
  p: (p) => <p className="my-1.5 first:mt-0 last:mb-0" {...p} />,
  strong: (p) => <strong className="font-semibold text-fg" {...p} />,
  em: (p) => <em className="italic" {...p} />,
  a: (p) => <a className="text-accent underline underline-offset-2 hover:text-accent-hi" target="_blank" rel="noreferrer" {...p} />,
  ul: (p) => <ul className="my-1.5 list-disc space-y-0.5 pl-5 marker:text-muted" {...p} />,
  ol: (p) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5 marker:text-muted" {...p} />,
  li: (p) => <li {...p} />,
  h1: (p) => <h1 className="mb-1.5 mt-3 text-[15px] font-semibold tracking-[-0.01em] first:mt-0" {...p} />,
  h2: (p) => <h2 className="mb-1.5 mt-3 text-[14px] font-semibold tracking-[-0.01em] first:mt-0" {...p} />,
  h3: (p) => <h3 className="mb-1 mt-2.5 text-[13.5px] font-semibold first:mt-0" {...p} />,
  blockquote: (p) => <blockquote className="my-1.5 border-l-2 border-line pl-3 text-fg-dim" {...p} />,
  hr: () => <hr className="my-3 border-line" />,
  code: (p) => <code className="rounded bg-ink/70 px-1.5 py-0.5 font-mono text-[12px] text-accent-hi [overflow-wrap:anywhere]" {...p} />,
  pre: (p) => (
    <pre className="my-2 overflow-x-auto rounded-lg border border-line bg-ink/70 p-3 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[12px] [&_code]:text-fg-dim" {...p} />
  ),
  table: (p) => <table className="my-2 w-full border-collapse text-[12.5px]" {...p} />,
  th: (p) => <th className="border border-line px-2 py-1 text-left font-semibold" {...p} />,
  td: (p) => <td className="border border-line px-2 py-1" {...p} />,
};

// User-message bubble variant. The bubble is the coral accent surface with dark `text-accent-ink` text, so the
// dark-deck MD_COMPONENTS colors (text-fg strong, coral links, dark code chips) would be low-contrast or invisible.
// These inherit the bubble's currentColor and tint code/quotes/rules with accent-ink instead. Mention chips (below)
// reuse the same bubble-chip tone as the old MentionText.
const MD_BUBBLE_COMPONENTS: Components = {
  p: (p) => <p className="my-1.5 first:mt-0 last:mb-0" {...p} />,
  strong: (p) => <strong className="font-semibold" {...p} />,
  em: (p) => <em className="italic" {...p} />,
  a: (p) => <a className="font-medium underline decoration-accent-ink/50 underline-offset-2" target="_blank" rel="noreferrer" {...p} />,
  ul: (p) => <ul className="my-1.5 list-disc space-y-0.5 pl-5 marker:text-accent-ink/55" {...p} />,
  ol: (p) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5 marker:text-accent-ink/55" {...p} />,
  li: (p) => <li {...p} />,
  h1: (p) => <h1 className="mb-1.5 mt-3 text-[15px] font-semibold tracking-[-0.01em] first:mt-0" {...p} />,
  h2: (p) => <h2 className="mb-1.5 mt-3 text-[14px] font-semibold tracking-[-0.01em] first:mt-0" {...p} />,
  h3: (p) => <h3 className="mb-1 mt-2.5 text-[13.5px] font-semibold first:mt-0" {...p} />,
  blockquote: (p) => <blockquote className="my-1.5 border-l-2 border-accent-ink/30 pl-3 opacity-85" {...p} />,
  hr: () => <hr className="my-3 border-accent-ink/25" />,
  code: (p) => <code className="rounded bg-accent-ink/12 px-1.5 py-0.5 font-mono text-[12px] [overflow-wrap:anywhere]" {...p} />,
  pre: (p) => (
    <pre className="my-2 overflow-x-auto rounded-lg border border-accent-ink/20 bg-accent-ink/10 p-3 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[12px]" {...p} />
  ),
  table: (p) => <table className="my-2 w-full border-collapse text-[12.5px]" {...p} />,
  th: (p) => <th className="border border-accent-ink/25 px-2 py-1 text-left font-semibold" {...p} />,
  td: (p) => <td className="border border-accent-ink/25 px-2 py-1" {...p} />,
  // @/path mentions injected by rehypeMentions below → render as the shortened filename chip (matches the old MentionText bubble tone).
  span: (p: any) =>
    String(p.className ?? "").includes("md-mention")
      ? <span title={p.title} className="mx-px inline-flex items-baseline rounded bg-accent-ink/12 px-1 py-px text-[0.92em] font-medium">{p.children}</span>
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

// memo: skip re-parsing when children are unchanged — prevents re-parsing other (finalized) messages on every streamed token.
export const Markdown = memo(function Markdown({ children }: { children: string }): JSX.Element {
  return (
    <div className="text-[13.5px] leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {children}
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
    <div className="md-streaming text-[13.5px] leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[plugin]} components={MD_COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
