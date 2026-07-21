import { Loader2 } from "lucide-react";
import { cn } from "../lib/cn.js";
import { useJustEnded } from "../lib/useJustEnded.js";
import { toneClass, railClass, statusLabelKey, isLive, isProvisioning } from "../lib/status.js";
import { useT } from "../i18n/provider.js";

export function StatusBadge({ status }: { status: string }): JSX.Element {
  const t = useT();
  // status-flash fires once only on the live→settled transition. Keyed off isLive (not "running") so the
  // running→background hand-off — where work continues — does not flash a false "finished" cue. It does not
  // fire on history replay where the component mounts already settled (useJustEnded is false at mount).
  const justEnded = useJustEnded(isLive(status));
  return (
    <span
      role="status"
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-1.5 py-0.5 font-mono text-[11px] font-medium transition-colors duration-200",
        toneClass(status),
      )}
    >
      {isProvisioning(status) ? (
        <Loader2 size={11} className="animate-spin" />
      ) : (
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full transition-colors duration-200",
            railClass(status),
            isLive(status) && "led-live",
            justEnded && "status-flash",
          )}
        />
      )}
      {t(statusLabelKey(status))}
    </span>
  );
}

// Codex worker-provider badge (fleet-tree row + worker header). "Codex" is a literal proper noun, not translated —
// same convention as e.g. "GitHub"/"Linear" elsewhere in the settings page. Static (no status coloring, unlike
// StatusBadge above): absent/"claude" (the default) renders no badge at all — this is a visual-default opt-in,
// not a claude badge/no-badge pair.
export function ProviderBadge({ provider }: { provider?: string }): JSX.Element | null {
  if (provider !== "codex") return null;
  return (
    <span className="inline-flex shrink-0 items-center rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted">
      Codex
    </span>
  );
}
