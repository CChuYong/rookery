import { useRef, useState } from "react";
import { Input, Select } from "../ui/input.js";
import { Button } from "../ui/button.js";
import { EFFORTS, codexDefaultEffort, codexEffortsFor, effectiveEffort, effortLabelKey, effortSupported } from "../lib/models.js";
import { useStore } from "../store/store.js";
import { useModalKeys } from "../lib/useModalKeys.js";
import { useDismissTransition } from "../lib/useDismissTransition.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { Segment, type SegmentItem } from "../ui/segment.js";
import { useT } from "../i18n/provider.js";
import { dialogOverlayClass, dialogPanelClass } from "../ui/dialog.js";

type Provider = "claude" | "codex";

// Cross-provider fork dialog (provider handoff). Picks the TARGET backend + model + effort, gating a codex
// target on the codex auth probe (codexAuthStatus). The default target is the OTHER provider — the whole point
// is "continue this Claude conversation on Codex" (and vice-versa). onFork receives { provider, model?, effort? };
// the caller (App.tsx) decides how to send it (session.fork provider-only + a client-side override; worker.fork
// carries model/effort as columns). See docs/2026-07-08-cross-provider-fork-design.md §U6.
export function ForkDialog(p: {
  kind: "master" | "worker";
  sourceProvider: string;
  onFork: (target: { provider: string; model?: string; effort?: string }) => void;
  onClose: () => void;
}): JSX.Element {
  const t = useT();
  const settings = useStore((s) => s.settings);
  const models = useStore((s) => s.models); // Claude live model list (static fallback if absent)
  const codexModels = useStore((s) => s.codexModels); // codex catalog; null = couldn't fetch → free-text fallback
  const codexAuthStatus = useStore((s) => s.codexAuthStatus); // codex backend auth readiness; null = still probing

  // Backend defaults differ for master vs worker (masterModel vs workerModel etc.).
  const isMaster = p.kind === "master";
  const claudeDefaultModel = (isMaster ? settings?.masterModel : settings?.workerModel) ?? "claude-opus-4-8";
  const defaultEffort = (isMaster ? settings?.masterEffort : settings?.workerEffort) ?? "high";
  const codexDefaultModel = (isMaster ? settings?.codexMasterModel : settings?.codexWorkerModel) || "gpt-6.2-sol";

  // Default the target to the OTHER provider (the handoff intent). Same-provider is still selectable (native fork).
  const [provider, setProvider] = useState<Provider>(p.sourceProvider === "claude" ? "codex" : "claude");
  // Separate model states so switching provider back and forth doesn't clobber either field's value
  // (Claude <Select> and codex field remember their own last value — same idiom as WorkerSpawnPage).
  const [model, setModel] = useState(claudeDefaultModel);
  const [codexModel, setCodexModel] = useState("");
  const [effort, setEffort] = useState(defaultEffort);

  const { closing, dismiss } = useDismissTransition(p.onClose);

  // The model text actually in play — the Claude catalog selection, or the codex field (select or free-text).
  const effectiveModel = provider === "codex" ? codexModel : model;
  // The codex model whose effort vocabulary applies — the picked model, or the daemon default when "" (same
  // idiom as WorkerSpawnPage/NewSessionPage), so the "" selection offers that model's real efforts.
  const effortModel = effectiveModel || codexDefaultModel || "";
  const codexEfforts = provider === "codex" && codexModels != null ? codexEffortsFor(effortModel, codexModels) : null;
  const effortOptions: readonly string[] = codexEfforts && codexEfforts.length > 0 ? codexEfforts : EFFORTS;
  // Derived at render time (no state-syncing effect): a stale Claude-vocab level re-derives to the model's
  // catalog default so the <select> never renders blank and we never submit a level the model lacks (finding [23]).
  const currentEffort = effectiveEffort(provider, effortModel, effort, codexModels);

  // Auth-probe gate: a codex target requires a ready probe. null (still probing), "unavailable" (probe couldn't
  // run), and { ready:false } all block the fork — this is the concrete payoff of the codex auth probe.
  const codexReady = codexAuthStatus != null && codexAuthStatus !== "unavailable" && codexAuthStatus.ready === true;
  const codexBlocked = provider === "codex" && !codexReady;

  const PROVIDERS: Array<SegmentItem<Provider>> = [
    { value: "claude", label: t("forkDialog.providerClaude") },
    { value: "codex", label: t("forkDialog.providerCodex") },
  ];

  const doFork = () => {
    if (codexBlocked) return;
    // codex: empty free-text/"" → omit model so the daemon falls back to its codex*Model default.
    const chosenModel = provider === "codex" ? (codexModel.trim() || undefined) : model;
    const chosenEffort = effortSupported(effectiveModel) ? currentEffort : undefined;
    p.onFork({
      provider,
      ...(chosenModel ? { model: chosenModel } : {}),
      ...(chosenEffort ? { effort: chosenEffort } : {}),
    });
    dismiss();
  };
  useModalKeys({ escape: "ignore", onSubmit: doFork });
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);

  const crossProvider = provider !== p.sourceProvider;

  return (
    <div
      className={dialogOverlayClass({ closing })}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t(isMaster ? "forkDialog.titleMaster" : "forkDialog.titleWorker")}
        className={dialogPanelClass({ size: "md", closing })}
      >
        <div className="mb-1 text-title font-medium text-fg">{t(isMaster ? "forkDialog.titleMaster" : "forkDialog.titleWorker")}</div>
        <div className="mb-3 text-body text-muted">{t(isMaster ? "forkDialog.subtitleMaster" : "forkDialog.subtitleWorker")}</div>

        <div className="flex flex-col gap-2">
          {/* Target backend — default = the other provider (the handoff intent). */}
          <div className="text-ui text-muted">{t("forkDialog.provider")}</div>
          <Segment
            items={PROVIDERS}
            value={provider}
            onChange={setProvider}
            variant="pill"
            aria-label={t("forkDialog.provider")}
            className="gap-1 rounded-[var(--radius)] border border-line bg-sunk p-1"
            itemClassName="flex-1 justify-center py-1.5 text-ui font-medium"
          />

          <div className="flex gap-2">
            {provider === "codex" ? (
              codexModels != null ? (
                // codex catalog fetched — dropdown; selecting a model also pre-selects its default effort.
                <Select
                  size="sm"
                  className="flex-1"
                  value={codexModel}
                  onChange={(e) => {
                    const nm = e.target.value;
                    setCodexModel(nm);
                    const de = codexDefaultEffort(nm, codexModels);
                    if (de) setEffort(de);
                  }}
                  title={t("forkDialog.modelTitle")}
                >
                  {/* Leading "" = "use the codex*Model settings default" (never auto-pick a catalog id). */}
                  <option value="">{codexDefaultModel ? t("settings.codexModelDefaultOptionWith", { model: codexDefaultModel }) : t("settings.codexModelDefaultOption")}</option>
                  {codexModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.displayName}</option>
                  ))}
                  {!codexModels.some((m) => m.id === codexModel) && codexModel && <option value={codexModel}>{codexModel}</option>}
                </Select>
              ) : (
                // codex catalog unavailable — free text, daemon default when empty.
                <Input
                  size="sm"
                  className="flex-1"
                  value={codexModel}
                  onChange={(e) => setCodexModel(e.target.value)}
                  placeholder={codexDefaultModel}
                  title={t("forkDialog.modelTitle")}
                />
              )
            ) : (
              <Select size="sm" className="flex-1" value={model} onChange={(e) => setModel(e.target.value)} title={t("forkDialog.modelTitle")}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
                {!models.some((m) => m.id === model) && <option value={model}>{model}</option>}
              </Select>
            )}
            {effortSupported(effectiveModel) && (
              <Select size="sm" className="w-28" value={currentEffort} onChange={(e) => setEffort(e.target.value)} title={t("forkDialog.effortTitle")}>
                {effortOptions.map((ef) => (
                  <option key={ef} value={ef}>{t(effortLabelKey(ef))}</option>
                ))}
              </Select>
            )}
          </div>

          {/* Same/cross-provider note (informational). */}
          <p className="text-meta leading-relaxed text-muted">{crossProvider ? t("forkDialog.crossNote") : t("forkDialog.sameNote")}</p>

          {/* Codex auth-probe gate — mirrors the SettingsPage readiness card colours (stop dot for not-ready). */}
          {codexBlocked && (
            <div className="flex items-start gap-2 rounded-[var(--radius)] border border-stop/40 bg-stop/10 px-2.5 py-2 text-meta text-fg">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-stop" />
              <span className="leading-relaxed">{t("forkDialog.codexNotReady")}</span>
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={dismiss}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={doFork} disabled={codexBlocked}>{t("forkDialog.fork")}</Button>
        </div>
      </div>
    </div>
  );
}
