import type { SpeedObservation, SpeedPreference } from "@daemon/core/speed.js";
import type { CodexModelInfo } from "@daemon/protocol/messages.js";
import { useStore } from "../store/store.js";
import { useT } from "../i18n/provider.js";
import type { TFunc } from "../i18n/provider.js";
import { fastAvailability } from "../lib/speed.js";
import { cn } from "../lib/cn.js";
import { Select } from "../ui/input.js";

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
  // "chip" = the borderless composer look; "field" = a bordered form select (forms, menus), audit #92.
  variant?: "chip" | "field";
  // field only: the caller already shows a label (a settings row, a menu field), so don't repeat it above the select.
  hideLabel?: boolean;
  fieldClassName?: string; // field only: width of the select (e.g. a settings row's fixed column)
}

export interface SpeedState {
  requested: SpeedPreference;
  availability: ReturnType<typeof fastAvailability>;
  explanation?: string; // provider status + reason, when there is one
  degraded: boolean; // Fast was asked for but the provider reports it isn't running Fast
}

// Shared by the control and the composer's model-menu trigger (which shows the "not honoured" dot while the menu is
// closed). Intent never certifies provider state.
export function speedState(
  t: TFunc,
  { speed, defaultSpeed = "standard", provider, model, pendingNextTurn, observation, lastObservation }: Pick<SpeedControlProps, "speed" | "defaultSpeed" | "provider" | "model" | "pendingNextTurn" | "observation" | "lastObservation">,
  catalog: CodexModelInfo[] | null,
): SpeedState {
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
  // Fast was asked for but the provider says it isn't running Fast (cooldown, or reported Standard). The inline status
  // text was removed to keep the composer quiet, so without this the only trace was a native tooltip on "Fast".
  const degraded = !pending && requested === "fast" && (reported?.state === "cooldown" || reported?.state === "standard");
  return { requested, availability, explanation, degraded };
}

export function SpeedControl(props: SpeedControlProps): JSX.Element {
  const { speed, defaultSpeed = "standard", onChange, disabled, allowInherit = true, label, variant = "chip", hideLabel, fieldClassName } = props;
  const t = useT();
  const catalog = useStore((s) => s.codexModels);
  const { requested, availability, explanation, degraded } = speedState(t, props, catalog);
  // The tooltip always says what the control means (cost + when it applies) unless a provider status is more specific.
  const title = explanation ?? t("speed.hint");
  const name = label ?? t("speed.label");
  const options = (
    <>
      {allowInherit && <option value="">{t("speed.inherit", { speed: defaultSpeed === "fast" ? "Fast" : "Standard" })}</option>}
      <option value="standard">{t("speed.standard")}</option>
      <option value="fast" disabled={availability === "unsupported"}>{t("speed.fast")}</option>
    </>
  );
  const change = (value: string): void => onChange?.(value === "" ? null : value as SpeedPreference);
  if (variant === "field") {
    const select = onChange ? (
      <Select aria-label={name} title={title} value={speed ?? ""} disabled={disabled} onChange={(event) => change(event.target.value)} className={cn("w-full", fieldClassName)}>
        {options}
      </Select>
    ) : <span title={title} className="text-ui text-fg-dim">{t("speed.inherited", { speed: requested === "fast" ? "Fast" : "Standard" })}</span>;
    return (
      <span className="flex min-w-0 flex-col gap-1">
        {!hideLabel && <span className="text-ui text-fg-dim">{name}</span>}
        {select}
        {degraded && explanation && <span className="text-meta text-warn">{explanation}</span>}
      </span>
    );
  }
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1 text-meta text-muted">
      {onChange ? (
        <select
          aria-label={name}
          title={title}
          className="[field-sizing:content] h-6 min-w-0 cursor-pointer appearance-none rounded border-0 bg-transparent px-1.5 text-ui text-fg-dim hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
          value={speed ?? ""}
          disabled={disabled}
          onChange={(event) => change(event.target.value)}
        >
          {options}
        </select>
      ) : <span title={title}>{t("speed.inherited", { speed: requested === "fast" ? "Fast" : "Standard" })}</span>}
      {degraded && <SpeedMismatchDot title={explanation ?? t("speed.mismatch")} />}
    </span>
  );
}

/** The quiet dot that marks a Fast request the provider did not honour. */
export function SpeedMismatchDot({ title, className }: { title: string; className?: string }): JSX.Element {
  const t = useT();
  return <span role="img" aria-label={t("speed.mismatch")} title={title} className={cn("-ml-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent", className)} />;
}
