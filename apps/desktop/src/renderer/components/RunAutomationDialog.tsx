import { useRef, useState } from "react";
import type { Automation } from "@daemon/persistence/repositories.js";
import type { ActionVars } from "@daemon/core/automation-action.js";
import { referencedVars } from "../lib/automation-vars.js";
import { useT } from "../i18n/provider.js";
import { Button } from "../ui/button.js";
import { Input, Textarea } from "../ui/input.js";
import { useDismissTransition } from "../lib/useDismissTransition.js";
import { useModalKeys } from "../lib/useModalKeys.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { cn } from "../lib/cn.js";

function actionText(a: Automation): string {
  return a.action.kind === "master" ? a.action.prompt : a.action.task;
}

export function RunAutomationDialog({ automation, onClose, onRun }: {
  automation: Automation;
  onClose: () => void;
  onRun: (vars: ActionVars) => void;
}): JSX.Element {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const names = referencedVars(actionText(automation));
  const [vals, setVals] = useState<Record<string, string>>({});
  const { closing, dismiss } = useDismissTransition(onClose);
  const submit = (): void => {
    const vars: ActionVars = {};
    for (const n of names) (vars as Record<string, string>)[n] = vals[n] ?? "";
    onRun(vars);
  };
  useModalKeys(dismiss, submit);
  useFocusTrap(panelRef);
  return (
    <div
      className={cn("fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm", closing ? "motion-safe:animate-[overlay-out_130ms_ease-in]" : "motion-safe:animate-[overlay-in_160ms_ease-out]")}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("runAutomationDialog.title")}
        className={cn("flex max-h-[calc(100vh-2rem)] w-full max-w-md flex-col overflow-hidden rounded-xl border border-line bg-surface", closing ? "motion-safe:animate-[dialog-out_140ms_ease-in]" : "motion-safe:animate-[dialog-in_180ms_ease-out]")}
      >
        <div className="shrink-0 px-5 pb-3 pt-5">
          <div className="text-[14px] font-semibold">{t("runAutomationDialog.title")} · {automation.name}</div>
          <p className="mt-3 text-[12px] text-muted">{t("runAutomationDialog.desc")}</p>
        </div>
        <div data-dialog-scroll-body className="min-h-0 overflow-y-auto px-5 pb-4">
          <div className="flex flex-col gap-2.5">
            {names.map((n) => (
              <label key={n} className="flex flex-col gap-1">
                <span className="font-mono text-[11px] text-muted">{`{{${n}}}`}</span>
                {n === "message" ? (
                  <Textarea autoFocus rows={3} className="resize-y" value={vals[n] ?? ""} onChange={(e) => setVals((v) => ({ ...v, [n]: e.target.value }))} />
                ) : (
                  <Input value={vals[n] ?? ""} onChange={(e) => setVals((v) => ({ ...v, [n]: e.target.value }))} />
                )}
              </label>
            ))}
          </div>
        </div>
        <div data-dialog-footer className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-4">
          <Button variant="outline" size="sm" onClick={dismiss}>{t("common.cancel")}</Button>
          <Button variant="primary" size="sm" onClick={submit}>{t("runAutomationDialog.run")}</Button>
        </div>
      </div>
    </div>
  );
}
