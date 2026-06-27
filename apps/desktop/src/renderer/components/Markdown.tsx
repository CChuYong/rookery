import { memo, useEffect, useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

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
