import { Fragment } from "react";
import { basename } from "../lib/basename.js";
import { cn } from "../lib/cn.js";

// Render "@/absolute-path" mentions in the message body as filename chips (everything else stays as-is). Paths are assumed to be absolute with no spaces
// (the composer serializes them that way — a path containing spaces becomes a chip only up to the first space, visual best-effort).
const MENTION = /(^|\s)@(\/\S+)/g;

type Part = { kind: "text"; text: string } | { kind: "chip"; lead: string; path: string };

function splitMentions(text: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    const start = m.index ?? 0;
    if (start > last) parts.push({ kind: "text", text: text.slice(last, start) });
    parts.push({ kind: "chip", lead: m[1], path: m[2] });
    last = start + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

export function MentionText({ text, tone = "default" }: { text: string; tone?: "default" | "bubble" }): JSX.Element {
  const parts = splitMentions(text);
  if (parts.every((p) => p.kind === "text")) return <>{text}</>; // no mentions, return as-is
  const chipCls = tone === "bubble"
    ? "bg-accent-ink/12 text-accent-ink" // on an accent bubble (user message)
    : "bg-accent/15 text-accent-hi";
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "chip" ? (
          <Fragment key={i}>
            {p.lead}
            <span title={p.path} className={cn("mx-px inline-flex items-baseline rounded px-1 py-px text-[0.92em] font-medium", chipCls)}>
              @{basename(p.path)}
            </span>
          </Fragment>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}
