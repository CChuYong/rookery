import { useState } from "react";
import { Blocks, FolderGit2, X } from "lucide-react";
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
      <header className="flex shrink-0 items-start gap-4 border-b border-line px-6 py-4">
        <span className="mt-0.5 rounded-lg border border-line bg-raised p-2 text-accent"><FolderGit2 size={17} /></span>
        <div className="min-w-0 flex-1"><p className="text-[10.5px] font-medium uppercase tracking-wide text-muted">{t("repositorySettings.title")}</p><h1 className="mt-0.5 text-[17px] font-semibold text-fg">{repo.name}</h1><p className="mt-1 truncate font-mono text-[10.5px] text-muted" title={repo.path}>{repo.path}</p></div>
        <Button variant="ghost" size="iconSm" aria-label={t("common.close")} onClick={onClose}><X size={16} /></Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label={t("repositorySettings.navigation")} className="w-56 shrink-0 border-r border-line bg-surface/35 p-3">
          {repositorySettingsSections.map((item) => <button key={item.id} onClick={() => setSection(item.id)} className={cn("flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors", section === item.id ? "bg-accent/12 text-fg" : "text-fg-dim hover:bg-raised")}><Blocks size={14} className={cn("mt-0.5 shrink-0", section === item.id ? "text-accent" : "text-muted")} /><span><span className="block text-[12.5px] font-medium">{t(item.labelKey)}</span><span className="mt-0.5 block text-[10px] leading-relaxed text-muted">{t(item.descriptionKey)}</span></span></button>)}
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-5xl px-7 py-7">{section === "capabilities" && <RepositoryCapabilitiesSection repoId={repo.id} api={api} generation={generation} onOpenCatalog={onOpenCatalog} onOpenAdvancedAssignments={onOpenAdvancedAssignments} onPreviewEffective={onPreviewEffective} />}</div></main>
      </div>
    </div>
  );
}
