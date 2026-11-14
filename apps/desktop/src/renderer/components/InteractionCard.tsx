import { useState } from "react";
import { CheckCircle2, KeyRound, HelpCircle } from "lucide-react";
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
  // Which action was clicked and sent to the daemon (interaction.respond is fire-and-forget, so this is our only
  // in-flight signal until interaction.resolved swaps the card for a summary — see item.resolved below).
  const [sent, setSent] = useState<false | "allow" | "deny" | "submit" | "skip">(false);

  if (item.resolved) {
    return (
      <div className="max-w-[80%] self-start whitespace-pre-wrap rounded-md border border-line-soft bg-surface px-3 py-2 text-ui text-fg-dim">
        {item.summary ?? (item.expired ? t("interactionCard.expired") : <CheckCircle2 size={14} className="inline-block -mt-0.5 text-pr" aria-hidden />)}
      </div>
    );
  }

  // the one spot that keeps a bordered card: an interaction needs a turn's worth of actions and reads as a
  // distinct decision, not a message line — the accent line is a 2px edge, never a fill.
  const cardCls = "max-w-[80%] self-start rounded-md border border-line border-l-2 border-l-accent/70 bg-surface px-3 py-2.5";
  const sendingHint = sent ? <div className="mt-1.5 text-meta text-fg-dim">{t("interactionCard.sending")}</div> : null;

  if (item.mode === "approve") {
    const respond = (decision: "allow" | "deny"): void => {
      setSent(decision);
      onRespond?.(item.requestId, { decision });
    };
    return (
      <div className={cardCls}>
        <div className="mb-1.5 flex items-center gap-1.5 text-body text-fg">
          <KeyRound size={14} className="shrink-0 text-muted" aria-hidden /> {t("interactionCard.approvePrompt")}
        </div>
        {item.toolName ? <div className="mb-1 font-mono text-ui text-accent">{item.toolName}</div> : null}
        {item.inputText ? <div className="mb-2 max-h-24 overflow-auto rounded bg-raised px-2 py-1 font-mono text-meta text-fg-dim">{item.inputText}</div> : null}
        <div className="flex gap-2">
          <Button variant="primary" size="sm" disabled={!!sent} loading={sent === "allow"} onClick={() => respond("allow")}>{t("interactionCard.approve")}</Button>
          <Button variant="danger" size="sm" disabled={!!sent} loading={sent === "deny"} onClick={() => respond("deny")}>{t("interactionCard.deny")}</Button>
        </div>
        {sendingHint}
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
    setSent("submit");
    const answers: Record<string, string | string[]> = {};
    questions.forEach((q, qi) => {
      const sel = picked[qi] ?? [];
      answers[q.question] = q.multiSelect ? sel : (sel[0] ?? "");
    });
    onRespond?.(item.requestId, { answers });
  };
  // Escape hatch for when none of the offered options fit: resolves with empty answers (the same shape the
  // registry already falls back to when no canUseTool handler is present) instead of forcing a Stop of the whole turn.
  const skip = (): void => {
    setSent("skip");
    onRespond?.(item.requestId, { answers: {} });
  };

  return (
    <div className={cardCls}>
      <div className="mb-2 flex items-center gap-1.5 text-ui text-fg-dim">
        <HelpCircle size={14} className="shrink-0 text-muted" aria-hidden /> {t("interactionCard.askPrompt")}
      </div>
      {questions.map((q, qi) => (
        <div key={qi} className="mb-2.5">
          <div className="mb-1 flex items-baseline gap-1.5 text-body text-fg">
            {q.header && <span className="text-fg-dim">{q.header}</span>}
            <span>{q.question}</span>
          </div>
          <div role="group" aria-label={q.question} className="flex flex-wrap gap-1.5">
            {q.options.map((o, oi) => (
              <Button
                key={oi}
                variant={(picked[qi] ?? []).includes(o.label) ? "primary" : "outline"}
                size="sm"
                title={o.description}
                aria-pressed={(picked[qi] ?? []).includes(o.label)}
                disabled={!!sent}
                onClick={() => toggle(qi, o.label, !!q.multiSelect)}
              >
                {o.label}
              </Button>
            ))}
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <Button variant="primary" size="sm" disabled={!allAnswered || !!sent} loading={sent === "submit"} onClick={submit}>{t("interactionCard.submit")}</Button>
        <Button variant="outline" size="sm" disabled={!!sent} loading={sent === "skip"} onClick={skip}>{t("interactionCard.skip")}</Button>
      </div>
      {sendingHint}
    </div>
  );
}
