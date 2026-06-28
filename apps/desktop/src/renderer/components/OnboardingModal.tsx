import { useState } from "react";
import { Sparkles, Bot, Users, Brain, ArrowRight } from "lucide-react";
import { useT } from "../i18n/provider.js";

// First-run onboarding (shown after the data-consent gate, before the app proper): a short welcome + a
// concept screen explaining rookery's master / worker-fleet / memory model. onFinish persists onboardingDone.
export function OnboardingModal({ onFinish }: { onFinish: () => void }): JSX.Element {
  const t = useT();
  const [step, setStep] = useState(0);
  const last = 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="rise-in mx-4 w-full max-w-md rounded-xl border border-line bg-surface p-8 shadow-2xl">
        {step === 0 ? (
          <div className="flex flex-col items-center text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 text-accent"><Sparkles size={22} /></div>
            <h2 className="text-lg font-semibold">{t("onboarding.welcomeTitle")}</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted">{t("onboarding.welcomeBody")}</p>
          </div>
        ) : (
          <div>
            <h2 className="text-center text-lg font-semibold">{t("onboarding.conceptTitle")}</h2>
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
            <button onClick={onFinish} className="rounded-md px-3 py-1.5 text-[12px] text-muted transition-colors hover:text-fg-dim">{t("onboarding.skip")}</button>
            {step > 0 && <button onClick={() => setStep(step - 1)} className="rounded-md px-3 py-1.5 text-[12px] text-fg-dim transition-colors hover:bg-raised">{t("onboarding.back")}</button>}
            {step < last ? (
              <button onClick={() => setStep(step + 1)} className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent/90">
                {t("onboarding.next")} <ArrowRight size={13} />
              </button>
            ) : (
              <button onClick={onFinish} className="rounded-lg bg-accent px-4 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent/90">{t("onboarding.getStarted")}</button>
            )}
          </div>
        </div>
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
