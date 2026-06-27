import { useState } from "react";
import type { LogItem } from "../store/reduce.js";
import { Button } from "../ui/button.js";
import { useT } from "../i18n/provider.js";

type Item = Extract<LogItem, { kind: "interaction" }>;

// Response payload the desktop sends to the daemon (interaction.respond).
export interface InteractionAnswer {
  decision?: "allow" | "deny";
  answers?: Record<string, string | string[]>;
}

// Inline card for master canUseTool (approve/AskUserQuestion). Once resolved, it is replaced by a one-line summary (buttons removed).
export function InteractionCard({ item, onRespond }: { item: Item; onRespond?: (requestId: string, res: InteractionAnswer) => void }): JSX.Element {
  const t = useT();
  // ask: question index → selected labels (single-select holds 1, multiSelect accumulates via toggle).
  const [picked, setPicked] = useState<Record<number, string[]>>({});

  if (item.resolved) {
    return (
      <div className="max-w-[80%] self-start whitespace-pre-wrap rounded-[var(--radius)] border border-line bg-surface px-3 py-2 text-[12px] text-fg-dim">
        {item.summary ?? "✅"}
      </div>
    );
  }

  const cardCls = "max-w-[80%] self-start rounded-[var(--radius)] border border-line border-l-2 border-l-accent/70 bg-surface px-3 py-2.5";

  if (item.mode === "approve") {
    return (
      <div className={cardCls}>
        <div className="mb-1.5 text-[13px] text-fg">🔐 {t("interactionCard.approvePrompt")}</div>
        {item.toolName ? <div className="mb-1 font-mono text-[12px] text-accent">{item.toolName}</div> : null}
        {item.inputText ? <div className="mb-2 max-h-24 overflow-auto rounded bg-raised px-2 py-1 font-mono text-[11px] text-fg-dim">{item.inputText}</div> : null}
        <div className="flex gap-2">
          <Button variant="primary" size="sm" onClick={() => onRespond?.(item.requestId, { decision: "allow" })}>{t("interactionCard.approve")}</Button>
          <Button variant="danger" size="sm" onClick={() => onRespond?.(item.requestId, { decision: "deny" })}>{t("interactionCard.deny")}</Button>
        </div>
      </div>
    );
  }

  const questions = item.questions ?? [];
  const toggle = (qi: number, label: string, multi: boolean): void => {
    setPicked((p) => {
      const cur = p[qi] ?? [];
      if (multi) return { ...p, [qi]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
      return { ...p, [qi]: [label] };
    });
  };
  const allAnswered = questions.length > 0 && questions.every((_, qi) => (picked[qi]?.length ?? 0) > 0);
  const submit = (): void => {
    const answers: Record<string, string | string[]> = {};
    questions.forEach((q, qi) => {
      const sel = picked[qi] ?? [];
      answers[q.question] = q.multiSelect ? sel : (sel[0] ?? "");
    });
    onRespond?.(item.requestId, { answers });
  };

  return (
    <div className={cardCls}>
      <div className="mb-2 text-[12px] text-fg-dim">❓ {t("interactionCard.askPrompt")}</div>
      {questions.map((q, qi) => (
        <div key={qi} className="mb-2.5">
          <div className="mb-1 text-[13px] text-fg">{q.header ? <span className="text-fg-dim">{q.header} · </span> : null}{q.question}</div>
          <div role="group" aria-label={q.question} className="flex flex-wrap gap-1.5">
            {q.options.map((o, oi) => (
              <Button
                key={oi}
                variant={(picked[qi] ?? []).includes(o.label) ? "primary" : "outline"}
                size="sm"
                title={o.description}
                aria-pressed={(picked[qi] ?? []).includes(o.label)}
                onClick={() => toggle(qi, o.label, !!q.multiSelect)}
              >
                {o.label}
              </Button>
            ))}
          </div>
        </div>
      ))}
      <Button variant="primary" size="sm" disabled={!allAnswered} onClick={submit}>{t("interactionCard.submit")}</Button>
    </div>
  );
}
