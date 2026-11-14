import { useState } from "react";
import { FolderGit2, X } from "lucide-react";
import { useT } from "../../i18n/provider.js";
import { cn } from "../../lib/cn.js";
import { Button } from "../../ui/button.js";
import type { CapabilityCenterApi } from "../capabilities/types.js";
import { RepositoryCapabilitiesSection } from "./RepositoryCapabilitiesSection.js";
import { repositorySettingsSections, type RepositorySettingsSectionId } from "./sections.js";

export interface RepositorySettingsPageProps {
  repo: { id: string; name: string; path: string };
  api: CapabilityCenterApi;
  generation: number;
  onClose(): void;
  onOpenCatalog(): void;
  onOpenAdvancedAssignments(): void;
  onPreviewEffective?(): void;
}

export function RepositorySettingsPage({ repo, api, generation, onClose, onOpenCatalog, onOpenAdvancedAssignments, onPreviewEffective = () => {} }: RepositorySettingsPageProps): JSX.Element {
  const t = useT();
  const [section, setSection] = useState<RepositorySettingsSectionId>("capabilities");
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-ink">
      <header className="flex h-10 shrink-0 items-center gap-2 px-5">
        <FolderGit2 size={14} className="shrink-0 text-faint" />
        <h1 className="truncate text-body font-medium text-fg">{repo.name}</h1>
        <span className="h-3 w-px shrink-0 bg-line" aria-hidden />
        <span className="min-w-0 truncate font-mono text-meta text-muted" title={repo.path}>{repo.path}</span>
        <Button variant="ghost" size="iconSm" className="ml-auto" aria-label={t("common.close")} onClick={onClose}><X size={14} /></Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label={t("repositorySettings.navigation")} className="w-[180px] shrink-0 overflow-y-auto bg-sunk py-2">
          {repositorySettingsSections.map((item) => <button key={item.id} onClick={() => setSection(item.id)} className={cn("flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors", section === item.id ? "bg-raised text-fg" : "text-fg-dim hover:bg-raised/60")}><span className="text-body font-medium">{t(item.labelKey)}</span><span className="text-meta leading-relaxed text-muted">{t(item.descriptionKey)}</span></button>)}
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-5xl px-6 py-6">{section === "capabilities" && <RepositoryCapabilitiesSection repoId={repo.id} api={api} generation={generation} onOpenCatalog={onOpenCatalog} onOpenAdvancedAssignments={onOpenAdvancedAssignments} onPreviewEffective={onPreviewEffective} />}</div></main>
      </div>
    </div>
  );
}
