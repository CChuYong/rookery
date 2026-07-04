import { Loader2 } from "lucide-react";
import { cn } from "../lib/cn.js";
import { useJustEnded } from "../lib/useJustEnded.js";
import { toneClass, railClass, statusLabelKey, isLive, isProvisioning } from "../lib/status.js";
import { useT } from "../i18n/provider.js";

export function StatusBadge({ status }: { status: string }): JSX.Element {
  const t = useT();
  // status-flash fires once only on the running→terminal transition. It does not fire on history
  // replay where the component mounts already in a terminal state (useJustEnded is false at mount).
  const justEnded = useJustEnded(status === "running");
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
