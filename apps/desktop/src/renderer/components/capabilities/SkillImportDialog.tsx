import { useRef, useState } from "react";
import { FolderOpen, X } from "lucide-react";
import type { CapabilityCatalogCreateResult, CapabilitySkillCreateInput } from "@daemon/core/capabilities/types.js";
import { useT } from "../../i18n/provider.js";
import { cn } from "../../lib/cn.js";
import { slugMcpId } from "../../lib/mcp-pack-draft.js";
import { useDismissTransition } from "../../lib/useDismissTransition.js";
import { useFocusTrap } from "../../lib/useFocusTrap.js";
import { useModalKeys } from "../../lib/useModalKeys.js";
import { Button } from "../../ui/button.js";
import { Input, Textarea } from "../../ui/input.js";

export interface SkillImportDialogProps {
  pickDirectory(): Promise<string | null>;
  create(input: CapabilitySkillCreateInput): Promise<CapabilityCatalogCreateResult>;
  onCreated(result: CapabilityCatalogCreateResult): void;
  onClose(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[10.5px] font-medium text-fg-dim">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function SkillImportDialog(props: SkillImportDialogProps): JSX.Element {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const [displayName, setDisplayName] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { closing, dismiss } = useDismissTransition(props.onClose);

  const submit = (): void => {
    if (busy) return;
    if (!displayName.trim() || !id.trim() || !sourcePath.trim()) {
      setError(t("capabilityCatalog.skillRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    void props.create({ id: id.trim(), displayName: displayName.trim(), description: description.trim(), sourcePath })
      .then((result) => { props.onCreated(result); dismiss(); })
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setBusy(false));
  };
  useModalKeys({ escape: "ignore", onSubmit: submit });
  useFocusTrap(panelRef);

  return (
    <div className={cn("fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-5 backdrop-blur-sm", closing ? "motion-safe:animate-[overlay-out_130ms_ease-in]" : "motion-safe:animate-[overlay-in_160ms_ease-out]")}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="skill-import-title" className={cn("flex max-h-[92vh] w-[min(620px,96vw)] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl", closing ? "motion-safe:animate-[dialog-out_140ms_ease-in]" : "motion-safe:animate-[dialog-in_180ms_ease-out]")}>
        <div className="flex shrink-0 items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1"><h2 id="skill-import-title" className="text-[15px] font-semibold text-fg">{t("capabilityCatalog.skillTitle")}</h2><p className="mt-1 text-[11px] text-muted">{t("capabilityCatalog.skillDescription")}</p></div>
          <Button variant="ghost" size="iconSm" aria-label={t("common.close")} disabled={busy} onClick={dismiss}><X size={15} /></Button>
        </div>
        <form className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <Field label={t("capabilityCatalog.name")}>
            <Input autoFocus className="w-full" size="sm" value={displayName} onChange={(event) => { const value = event.target.value; setDisplayName(value); if (!idTouched) setId(slugMcpId(value)); }} />
          </Field>
          <Field label={t("capabilityCatalog.id")}>
            <Input className="w-full" size="sm" value={id} onChange={(event) => { setIdTouched(true); setId(event.target.value); }} />
          </Field>
          <Field label={t("capabilityCatalog.description")}>
            <Textarea className="w-full" rows={3} size="sm" value={description} onChange={(event) => setDescription(event.target.value)} />
          </Field>
          <div>
            <span className="text-[10.5px] font-medium text-fg-dim">{t("capabilityCatalog.skillDirectory")}</span>
            <div className="mt-1 flex items-center gap-2">
              <Input className="min-w-0 flex-1" size="sm" readOnly aria-label={t("capabilityCatalog.skillDirectory")} value={sourcePath} />
              <Button className="shrink-0" type="button" variant="outline" size="sm" disabled={busy} onClick={() => { void props.pickDirectory().then((selected) => { if (selected) setSourcePath(selected); }); }}><FolderOpen size={13} /> {t("capabilityCatalog.chooseDirectory")}</Button>
            </div>
          </div>
          {error && <p role="alert" className="rounded-md border border-fail/30 bg-fail/5 p-3 text-[11px] text-fail">{error}</p>}
        </form>
        <div className="flex shrink-0 items-center gap-3 border-t border-line px-5 py-3"><p className="min-w-0 flex-1 text-[10.5px] text-run">{t("capabilityCatalog.skillTrustNotice")}</p><Button variant="outline" disabled={busy} onClick={dismiss}>{t("common.cancel")}</Button><Button variant="primary" loading={busy} onClick={submit}>{t("capabilityCatalog.importSkill")}</Button></div>
      </div>
    </div>
  );
}
