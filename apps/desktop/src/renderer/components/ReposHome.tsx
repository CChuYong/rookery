import { Plus } from "lucide-react";
import { useT } from "../i18n/provider.js";
import { LoadFailed } from "../ui/load-state.js";

// Repos main area with no worker selected (audit #23): the 40px header stays (same bar as every page) with the
// primary action on it, and the body is one muted line plus one text button (DESIGN empty-state rule).
// `loaded` = repos.list has answered: until then neither "no repositories" nor its CTA is shown (audit #89). If it
// failed (`loadFailed`), the body says so with a retry instead of staying blank (final review #12).
export function ReposHome({ hasRepos, loaded = true, loadFailed, onRetry, onNewWorker, onNewRepo }: { hasRepos: boolean; loaded?: boolean; loadFailed?: boolean; onRetry?: () => unknown; onNewWorker: () => void; onNewRepo: () => void }): JSX.Element {
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
      {!loaded && loadFailed && onRetry && <LoadFailed layout="stack" className="flex-1" message={t("app.reposLoadFailed")} onRetry={onRetry} />}
      {loaded && <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center text-body text-muted">
        <p>{hasRepos ? t("app.reposHomeHint") : t("app.reposHomeEmpty")}</p>
        <button onClick={hasRepos ? onNewWorker : onNewRepo} className="text-body text-fg-dim underline-offset-2 hover:text-fg hover:underline">
          {hasRepos ? t("app.newWorker") : t("repoTree.newRepo")}
        </button>
      </div>}
    </div>
  );
}
