import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkerSpawnPage } from "../src/renderer/components/WorkerSpawnPage.js";
import { useStore } from "../src/renderer/store/store.js";
import { useDraftStore, emptyDraftState } from "../src/renderer/store/drafts.js";
import { switchSpawnRepo, openSpawnedWorker } from "../src/renderer/lib/spawn-navigation.js";

// Integration-style: the spawn page wired to the real navigation store the way App wires it (the heading's repo select
// → switchSpawnRepo, a successful spawn → openSpawnedWorker with the spawn page's repo id).
const repos = [
  { id: "r1", name: "app", path: "/app", description: "", base: null },
  { id: "r2", name: "web", path: "/web", description: "", base: null },
];
const g = () => useStore.getState();

function SpawnPageHost(p: { spawn?: () => Promise<string> }): JSX.Element | null {
  const overlay = useStore((s) => s.overlay);
  const repoId = useStore((s) => s.repoSettingsId);
  const repo = repos.find((r) => r.id === repoId);
  if (overlay !== "spawnWorker" || !repo) return null;
  return (
    <WorkerSpawnPage
      key={repo.id}
      repo={repo.name}
      repos={repos}
      onRepoChange={switchSpawnRepo}
      defaultModel="claude-opus-4-8"
      defaultEffort="high"
      onSpawn={async () => {
        const id = await (p.spawn ?? (() => Promise.resolve("w-new")))();
        openSpawnedWorker(id, repo.id);
      }}
      onClose={() => g().navigate({ overlay: null })}
    />
  );
}

describe("spawn page navigation (Back never reopens a spent spawn form)", () => {
  beforeEach(() => {
    useDraftStore.setState(emptyDraftState());
    useStore.setState({ repos, overlay: null, showRepos: false, activeSessionId: "s1", activeWorkerId: null, repoSettingsId: null, navBack: [], navFwd: [] });
  });

  it("a successful spawn replaces the spawn page: Back returns to where the user was before opening it", async () => {
    g().navigate({ overlay: "spawnWorker", showRepos: true, repoId: "r1" }); // repo tree "+" pushes
    render(<SpawnPageHost />);
    fireEvent.change(screen.getByPlaceholderText(/적어주세요/), { target: { value: "do it" } });
    fireEvent.click(screen.getByRole("button", { name: "스폰" }));
    await waitFor(() => expect(g().activeWorkerId).toBe("w-new"));
    expect([g().overlay, g().navBack.length, g().navFwd.length]).toEqual([null, 1, 0]);
    g().goBack();
    expect([g().overlay, g().activeSessionId, g().showRepos]).toEqual([null, "s1", false]);
  });

  it("switching repo inside the page replaces its entry, so Back after spawn skips every spawn form", async () => {
    g().navigate({ overlay: "spawnWorker", showRepos: true, repoId: "r1" });
    render(<SpawnPageHost />);
    fireEvent.change(screen.getByRole("combobox", { name: "레포" }), { target: { value: "web" } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "레포" })).toHaveValue("web"));
    expect([g().repoSettingsId, g().navBack.length]).toEqual(["r2", 1]);
    fireEvent.click(screen.getByRole("button", { name: "스폰" }));
    await waitFor(() => expect(g().activeWorkerId).toBe("w-new"));
    g().goBack();
    expect([g().overlay, g().activeSessionId]).toEqual([null, "s1"]);
    expect(g().navBack).toHaveLength(0);
  });

  it("navigating away while the spawn is in flight pushes instead: the page the user moved to stays in history", async () => {
    let finish!: (id: string) => void;
    g().navigate({ overlay: "spawnWorker", showRepos: true, repoId: "r1" });
    render(<SpawnPageHost spawn={() => new Promise<string>((resolve) => { finish = resolve; })} />);
    fireEvent.click(screen.getByRole("button", { name: "스폰" }));
    g().navigate({ overlay: "settings" }); // the user leaves mid-spawn
    finish("w-late");
    await waitFor(() => expect(g().activeWorkerId).toBe("w-late"));
    expect(g().overlay).toBeNull();
    g().goBack();
    expect(g().overlay).toBe("settings");
    g().goBack();
    expect([g().overlay, g().repoSettingsId]).toEqual(["spawnWorker", "r1"]);
  });

  it("openSpawnedWorker pushes when the user has moved to another repo's spawn page", () => {
    g().navigate({ overlay: "spawnWorker", showRepos: true, repoId: "r1" });
    g().navigate({ overlay: "spawnWorker", showRepos: true, repoId: "r2" }); // tree "+" on another repo mid-spawn
    openSpawnedWorker("w1", "r1");
    expect(g().activeWorkerId).toBe("w1");
    g().goBack();
    expect([g().overlay, g().repoSettingsId]).toEqual(["spawnWorker", "r2"]);
  });
});
