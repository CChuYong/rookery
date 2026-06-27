import { AlertTriangle } from "lucide-react";
import { Button } from "../ui/button.js";
import { useT } from "../i18n/provider.js";

// Daemon connection failure notice (usually not Node 22 / no auth). If note is present, show the specific cause (e.g. ABI mismatch).
export function DaemonDownBanner({ note, onRetry }: { note: string | null; onRetry: () => void }): JSX.Element {
  const t = useT();
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-[420px] rounded-2xl border border-line bg-surface p-8 text-center">
        <AlertTriangle size={30} className="mx-auto mb-3 text-run" />
        <h2 className="mb-2 text-[17px] font-semibold">{t("daemonDownBanner.title")}</h2>
        {note
          ? <p className="text-[13px] leading-relaxed text-fail">{note}</p>
          : <p className="text-[13px] leading-relaxed text-muted">{t("daemonDownBanner.description")}</p>}
        <p className="mt-1 text-[12px] text-muted">
          {t("daemonDownBanner.logLabel")} <code className="rounded bg-ink px-1.5 py-0.5 font-mono text-[11px] text-fg-dim">~/.rookery/daemon.log</code>
        </p>
        <Button variant="primary" className="mt-5" onClick={onRetry}>{t("daemonDownBanner.retry")}</Button>
      </div>
    </div>
  );
}
