import { useStore } from "../store/store.js";

// History rules for the full-page worker spawn form (overlay "spawnWorker" + repoId). The form is one-shot: once a
// worker is spawned, Back must not land on a spent spawn form. The repo tree's "+" still pushes (opening the page is a
// real navigation); these two transitions replace instead.

// Re-target the open spawn page to another registered repo (the heading's repo select). Replaces the current entry,
// so switching repos inside the page never stacks spawn forms in history.
export function switchSpawnRepo(repoName: string): void {
  const st = useStore.getState();
  const repo = st.repos.find((r) => r.name === repoName);
  if (repo) st.navigateReplace({ overlay: "spawnWorker", showRepos: true, repoId: repo.id });
}

// Show a freshly spawned worker. If the user is still on the spawn page that started it, replace that page's entry
// (Back returns to where the user was before opening the form). If they navigated elsewhere while the spawn was in
// flight, push instead, so the page they moved to is not silently dropped from history.
export function openSpawnedWorker(subId: string, spawnRepoId: string | null): void {
  const st = useStore.getState();
  const patch = { overlay: null, showRepos: true, subId } as const;
  if (st.overlay === "spawnWorker" && st.repoSettingsId === spawnRepoId) st.navigateReplace(patch);
  else st.navigate(patch);
}
