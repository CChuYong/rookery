import type { CapabilityCenterApi } from "../capabilities/types.js";
import { CapabilityScopeBindings } from "../capabilities/CapabilityScopeBindings.js";

export interface RepositoryCapabilitiesSectionProps {
  repoId: string;
  api: CapabilityCenterApi;
  generation: number;
  onOpenCatalog(): void;
  onOpenAdvancedAssignments(): void;
  onPreviewEffective?(): void;
}

export function RepositoryCapabilitiesSection({ repoId, api, generation, onOpenCatalog, onOpenAdvancedAssignments, onPreviewEffective = () => {} }: RepositoryCapabilitiesSectionProps): JSX.Element {
  return <CapabilityScopeBindings scopeKind="repo-local" scopeRef={repoId} api={api} generation={generation} onOpenCatalog={onOpenCatalog} onOpenAdvancedAssignments={onOpenAdvancedAssignments} onPreviewEffective={onPreviewEffective} />;
}
