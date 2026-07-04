import { useId, useRef, useState } from "react";
import { Sparkles, Bot, Users, Brain, ArrowRight } from "lucide-react";
import { useT } from "../i18n/provider.js";
import { useModalKeys } from "../lib/useModalKeys.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { Button } from "../ui/button.js";

// First-run onboarding (shown after the data-consent gate, before the app proper): a short welcome + a
// concept screen explaining rookery's master / worker-fleet / memory model. onFinish persists onboardingDone
// and returns the settings.set promise so this modal owns success/failure feedback (audit #7).
export function OnboardingModal({ onFinish }: { onFinish: () => Promise<unknown> }): JSX.Element {
  const t = useT();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const last = 1;
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  const finish = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setErr(false);
    try {
      await onFinish();
      // On success, onboardingDone flips to "1" and the parent stops rendering this modal — no reset needed.
    } catch {
      setErr(true);
      setBusy(false);
    }
  };
  const advance = (): void => {
    if (step < last) setStep(step + 1);
    else void finish();
  };
  useModalKeys(() => void finish(), advance); // Cmd/Ctrl+Enter → Next/Get started (plain Enter activates the autofocused button natively), Escape → Skip (audit #25)
  useFocusTrap(panelRef);

  return (
    // audit #72 — overlay/panel classes aligned with the rest of the modal system (bg-black/55 backdrop-blur-sm +
    // the dialog-in entrance, replacing the one-off rise-in). No exit animation is wired here (no
    // useDismissTransition) — Escape/Skip/Get-started all resolve through onFinish, which unmounts this at the
    // App.tsx mount site once onboardingDone is persisted.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm">
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="mx-4 w-full max-w-md rounded-xl border border-line bg-surface p-8 shadow-2xl motion-safe:animate-[dialog-in_160ms_ease-out]">
        {step === 0 ? (
          <div className="flex flex-col items-center text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 text-accent"><Sparkles size={22} /></div>
            <h2 id={titleId} className="text-lg font-semibold">{t("onboarding.welcomeTitle")}</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted">{t("onboarding.welcomeBody")}</p>
          </div>
        ) : (
          <div>
            <h2 id={titleId} className="text-center text-lg font-semibold">{t("onboarding.conceptTitle")}</h2>
            <p className="mt-2 text-center text-[12px] leading-relaxed text-muted">{t("onboarding.conceptBody")}</p>
            <div className="mt-5 flex flex-col gap-3">
              <ConceptRow icon={<Bot size={16} />} title={t("onboarding.master")} desc={t("onboarding.masterDesc")} />
              <ConceptRow icon={<Users size={16} />} title={t("onboarding.worker")} desc={t("onboarding.workerDesc")} />
              <ConceptRow icon={<Brain size={16} />} title={t("onboarding.memory")} desc={t("onboarding.memoryDesc")} />
            </div>
          </div>
        )}

        <div className="mt-7 flex items-center">
          <div className="flex gap-1.5">
            {[0, 1].map((i) => (
              <span key={i} className={`h-1.5 rounded-full transition-all ${i === step ? "w-4 bg-accent" : "w-1.5 bg-line"}`} />
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button disabled={busy} onClick={() => void finish()} className="rounded-md px-3 py-1.5 text-[12px] text-muted transition-colors hover:text-fg-dim disabled:opacity-50">{t("onboarding.skip")}</button>
            {step > 0 && <button disabled={busy} onClick={() => setStep(step - 1)} className="rounded-md px-3 py-1.5 text-[12px] text-fg-dim transition-colors hover:bg-raised disabled:opacity-50">{t("onboarding.back")}</button>}
            {step < last ? (
              <Button variant="primary" size="sm" autoFocus disabled={busy} onClick={() => setStep(step + 1)}>
                {t("onboarding.next")} <ArrowRight size={13} />
              </Button>
            ) : (
              <Button variant="primary" size="sm" autoFocus loading={busy} onClick={() => void finish()}>
                {t("onboarding.getStarted")}
              </Button>
            )}
          </div>
        </div>
        {err && <p className="mt-2 text-right text-[12px] text-fail">{t("onboarding.saveFailed")}</p>}
      </div>
    </div>
  );
}

function ConceptRow({ icon, title, desc }: { icon: JSX.Element; title: string; desc: string }): JSX.Element {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-line bg-ink/40 px-3 py-2.5">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">{icon}</span>
      <div>
        <div className="text-[13px] font-medium text-fg">{title}</div>
        <div className="text-[11px] leading-relaxed text-muted">{desc}</div>
      </div>
    </div>
  );
}
