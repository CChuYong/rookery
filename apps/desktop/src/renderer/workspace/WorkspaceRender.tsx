import { createContext, useContext, type ReactNode } from "react";

// The dockview panels are dumb hosts: they render whatever the current page's
// delegate returns. App builds these delegates from its existing state/handlers
// (so the exact conversation/editor/terminal/files/git wiring is reused, not
// duplicated) and provides them per active page. Because these are functions on
// a context — never dockview panel `params` — they are not serialized into the
// saved layout, keeping params to plain identity.
export interface WorkspaceRender {
  conversation: () => ReactNode;
  editor: (tabId: string) => ReactNode;
  terminal: () => ReactNode;
  files: () => ReactNode;
  git: () => ReactNode;
  // Persisted name kept for saved-layout compatibility; this now hosts Activity (workflows + nested agents).
  nested: () => ReactNode;
}

const Ctx = createContext<WorkspaceRender | null>(null);

export function WorkspaceRenderProvider({ value, children }: { value: WorkspaceRender; children: ReactNode }): JSX.Element {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspaceRender(): WorkspaceRender {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspaceRender used outside WorkspaceRenderProvider");
  return v;
}
