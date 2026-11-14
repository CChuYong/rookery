import type { SpeedObservation, SpeedPreference } from "@daemon/core/speed.js";
import { useStore } from "../store/store.js";
import { useT } from "../i18n/provider.js";
import { fastAvailability } from "../lib/speed.js";

export interface SpeedControlProps {
  speed: SpeedPreference | null;
  defaultSpeed?: SpeedPreference;
  provider?: string;
  model: string;
  pendingNextTurn?: boolean;
  observation?: SpeedObservation;
  lastObservation?: SpeedObservation;
  onChange?: (value: SpeedPreference | null) => void;
  disabled?: boolean;
  allowInherit?: boolean;
  label?: string;
}

// Quiet text/select chrome shared by composers and setup forms. Intent never certifies provider state.
export function SpeedControl({ speed, defaultSpeed = "standard", provider, model, pendingNextTurn, observation, lastObservation, onChange, disabled, allowInherit = true, label }: SpeedControlProps): JSX.Element {
  const t = useT();
  const catalog = useStore((s) => s.codexModels);
  const availability = fastAvailability(provider, model, catalog);
  const requested = speed ?? defaultSpeed;
  const pending = pendingNextTurn || (observation && observation.requested !== requested);
  const reported = pending ? lastObservation : observation ?? lastObservation;
  const status = availability === "unsupported" && requested === "fast" ? t("speed.unsupported")
    : reported?.state === "fast" ? t("speed.activeFast")
    : reported?.state === "standard" ? t("speed.activeStandard")
    : reported?.state === "cooldown" ? t("speed.cooldown")
    : undefined;
  const explanation = [status, reported?.reason].filter(Boolean).join(". ") || undefined;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1 text-meta text-muted">
      {onChange ? (
        <select
          aria-label={label ?? t("speed.label")}
          title={explanation}
          className="[field-sizing:content] h-6 min-w-0 cursor-pointer appearance-none rounded border-0 bg-transparent px-1.5 text-ui text-fg-dim hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
          value={speed ?? ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value === "" ? null : event.target.value as SpeedPreference)}
        >
          {allowInherit && <option value="">{t("speed.inherit", { speed: defaultSpeed === "fast" ? "Fast" : "Standard" })}</option>}
          <option value="standard">{t("speed.standard")}</option>
          <option value="fast" disabled={availability === "unsupported"}>{t("speed.fast")}</option>
        </select>
      ) : <span title={explanation}>{t("speed.inherited", { speed: requested === "fast" ? "Fast" : "Standard" })}</span>}
    </span>
  );
}
