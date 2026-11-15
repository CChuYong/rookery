import { Plus } from "lucide-react";
import { useT } from "../i18n/provider.js";

// Repos main area with no worker selected (audit #23): the 40px header stays (same bar as every page) with the
// primary action on it, and the body is one muted line plus one text button (DESIGN empty-state rule).
export function ReposHome({ hasRepos, onNewWorker, onNewRepo }: { hasRepos: boolean; onNewWorker: () => void; onNewRepo: () => void }): JSX.Element {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="workspace-header drag flex h-10 shrink-0 items-center gap-2 px-4">
        <h1 className="min-w-0 truncate text-body font-medium text-fg">{t("app.navRepos")}</h1>
        {hasRepos && (
          <button onClick={onNewWorker} className="no-drag ml-auto flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-ui text-muted transition-colors hover:bg-raised hover:text-fg-dim">
            <Plus size={14} /> {t("app.newWorker")}
          </button>
        )}
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center text-body text-muted">
        <p>{hasRepos ? t("app.reposHomeHint") : t("app.reposHomeEmpty")}</p>
        <button onClick={hasRepos ? onNewWorker : onNewRepo} className="text-body text-fg-dim underline-offset-2 hover:text-fg hover:underline">
          {hasRepos ? t("app.newWorker") : t("repoTree.newRepo")}
        </button>
      </div>
    </div>
  );
}
