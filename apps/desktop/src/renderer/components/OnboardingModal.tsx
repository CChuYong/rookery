import { useId, useRef, useState } from "react";
import { Sparkles, Bot, Users, Brain, Boxes, ArrowRight } from "lucide-react";
import { useT } from "../i18n/provider.js";
import { useModalKeys } from "../lib/useModalKeys.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { Button } from "../ui/button.js";
import { dialogOverlayClass, dialogPanelClass } from "../ui/dialog.js";

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
  useModalKeys({ escape: "close", onEscape: () => void finish(), onSubmit: advance }); // Cmd/Ctrl+Enter → Next/Get started (plain Enter activates the autofocused button natively), Escape → Skip (audit #25)
  useFocusTrap(panelRef);

  return (
    // audit #72 — overlay/panel classes aligned with the rest of the modal system (bg-scrim +
    // the dialog-in entrance, replacing the one-off rise-in). No exit animation is wired here (no
    // useDismissTransition) — Escape/Skip/Get-started all resolve through onFinish, which unmounts this at the
    // App.tsx mount site once onboardingDone is persisted.
    <div className={dialogOverlayClass()}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className={dialogPanelClass({ size: "md" })}>
        {step === 0 ? (
          <div className="flex flex-col items-center text-center">
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full border border-line bg-raised text-fg-dim"><Sparkles size={18} /></div>
            <h2 id={titleId} className="text-title font-medium text-fg">{t("onboarding.welcomeTitle")}</h2>
            <p className="mt-3 text-body leading-relaxed text-muted">{t("onboarding.welcomeBody")}</p>
          </div>
        ) : (
          <div>
            <h2 id={titleId} className="text-center text-title font-medium text-fg">{t("onboarding.conceptTitle")}</h2>
            <p className="mt-2 text-center text-ui leading-relaxed text-muted">{t("onboarding.conceptBody")}</p>
            <div className="mt-5 flex flex-col gap-3">
              <ConceptRow icon={<Bot size={16} />} title={t("onboarding.master")} desc={t("onboarding.masterDesc")} />
              <ConceptRow icon={<Users size={16} />} title={t("onboarding.worker")} desc={t("onboarding.workerDesc")} />
              <ConceptRow icon={<Brain size={16} />} title={t("onboarding.memory")} desc={t("onboarding.memoryDesc")} />
              <ConceptRow icon={<Boxes size={16} />} title={t("onboarding.backends")} desc={t("onboarding.backendsDesc")} />
            </div>
          </div>
        )}

        <div className="mt-7 flex items-center">
          <div className="flex gap-1.5">
            {[0, 1].map((i) => (
              <span key={i} className={`h-1.5 rounded-full transition-colors duration-[var(--dur-micro)] ${i === step ? "w-4 bg-accent" : "w-1.5 bg-line"}`} />
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button disabled={busy} onClick={() => void finish()} className="rounded-md px-3 py-1.5 text-ui text-muted transition-colors hover:text-fg-dim disabled:opacity-50">{t("onboarding.skip")}</button>
            {step > 0 && <button disabled={busy} onClick={() => setStep(step - 1)} className="rounded-md px-3 py-1.5 text-ui text-fg-dim transition-colors hover:bg-raised disabled:opacity-50">{t("onboarding.back")}</button>}
            {step < last ? (
              <Button variant="primary" size="sm" autoFocus disabled={busy} onClick={() => setStep(step + 1)}>
                {t("onboarding.next")} <ArrowRight size={14} />
              </Button>
            ) : (
              <Button variant="primary" size="sm" autoFocus loading={busy} onClick={() => void finish()}>
                {t("onboarding.getStarted")}
              </Button>
            )}
          </div>
        </div>
        {err && <p className="mt-2 text-right text-ui text-fail">{t("onboarding.saveFailed")}</p>}
      </div>
    </div>
  );
}

function ConceptRow({ icon, title, desc }: { icon: JSX.Element; title: string; desc: string }): JSX.Element {
  return (
    <div className="flex items-start gap-3 border-b border-line-soft pb-3 last:border-b-0 last:pb-0">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-raised text-fg-dim">{icon}</span>
      <div>
        <div className="text-body font-medium text-fg">{title}</div>
        <div className="text-ui leading-relaxed text-muted">{desc}</div>
      </div>
    </div>
  );
}
