import { useT } from "../i18n/provider.js";
import type { SettingsValues } from "@daemon/core/settings.js";

interface DataConsentModalProps {
  settings: SettingsValues | null;
  daemon: "up" | "down" | "starting";
  onAccept: () => void;
}

export function DataConsentModal({ settings, daemon, onAccept }: DataConsentModalProps): JSX.Element | null {
  const t = useT();
  // Only show when connected AND settings loaded AND not accepted
  if (daemon !== "up" || settings === null || settings.hasAcceptedDataNotice === "1") {
    return null;
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-surface border border-line rounded-xl p-8 max-w-md w-full mx-4 shadow-2xl">
        <h2 className="text-lg font-semibold mb-4">{t("dataConsent.title")}</h2>
        <p className="text-sm text-muted mb-6">{t("dataConsent.body")}</p>
        <button
          className="w-full rounded-lg bg-accent text-white py-2 px-4 font-medium hover:bg-accent/90 transition-colors"
          onClick={onAccept}
        >
          {t("dataConsent.accept")}
        </button>
      </div>
    </div>
  );
}
