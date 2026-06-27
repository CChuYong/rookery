import { useEffect, useState } from "react";

// Enables recursive watching of the root and returns a version counter that increments whenever an fs:tree event arrives for that root.
// FileTree/GitChanges put this value in their deps to auto-refresh on change (live reflection of agent file changes).
export function useTreeVersion(root: string | null): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!root) return;
    window.rookery.ws.watchTree(root);
    const off = window.rookery.ws.onTree((changedRoot) => {
      if (changedRoot === root) setVersion((v) => v + 1);
    });
    return () => { off(); window.rookery.ws.unwatchTree(root); };
  }, [root]);
  return version;
}
