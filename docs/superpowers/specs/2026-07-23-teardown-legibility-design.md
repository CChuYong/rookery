# Worker teardown legibility (a: unify discard/delete · b: name+consequence)

Follow-up to the worker-recover work (same PR). A user asked why there are so many termination-ish verbs. The honest read: only 3 of the 5 actually *end* the worker (stop/discard/delete; interrupt+recover keep it), and 3 destructive verbs at distinct resource-reclamation scopes is normal for a system managing subprocess + git worktree + branch + record. Two real problems remained: (a) `discard` vs `delete` are near-redundant, and (b) the verbs weren't legible — the same word "중단/Stop" meant a soft turn-interrupt (composer) *and* a terminal worker-end (tree), which is exactly what confused the user.

## (a) Unify discard → full delete

`delete` was already `discard` (destroy worktree/branch) + `deleteWorker` (drop the row). So `discard` as an external verb only differed by leaving a worktree-less zombie row behind. Unified all external "discard" surfaces to the full delete:

- `src/tools/fleet-tools.ts` `discard_worker` → `fleet.delete` (was `fleet.discard`), description clarified.
- `src/tools/external-tools.ts` `discard_worker` → `fleet.delete`.
- `src/daemon/connection.ts` `fleet.discard` handler → `fleet.delete` (emits `worker.deletion`; the desktop already didn't call this message).

`FleetOrchestrator.discard()` stays as the internal building block of `delete()`. Result: one "destroy" outcome (worktree + branch + record) whether reached via the master's `discard_worker` tool, the external tool, the `fleet.discard` message, or the human "Delete". `stop_worker` stays the reversible "end but keep the worktree" verb.

## (b) Name + consequence at the point of action

- **Rename the tree's terminal Stop → "종료 / End"** (`repoTree.menuStop` value only). The composer's soft turn-interrupt stays "중단 / Stop". So the two no longer collide: composer 중단 = interrupt this turn (worker stays); tree 종료 = end the worker.
- **Consequence one-liners** via a new optional `hint` on `ContextMenu`'s `MenuItem` (rendered as a muted subtitle under the label):
  - End (`menuStopHint`): "워크트리 유지 · 재시작 시 복구" / "Keeps the worktree · resumable on restart"
  - Delete (`menuDeleteHint`): "워크트리·미커밋 작업까지 삭제 · 되돌릴 수 없음" / "Removes the worktree + uncommitted work · irreversible"
- **Composer Stop tooltip** (`composer.stopHint`): "이 턴만 멈춰요 (워커는 유지…)" — so the soft one announces its scope too. (Recover already had its hint; Delete's confirm dialog already stated its consequences.)

After (a)+(b) the human-facing ladder is a clean, self-describing 3 rungs: **중단**(턴, 소프트·복구) → **종료**(워커, 워크트리 유지·재시작 복구) → **삭제**(전부·불가). The count wasn't forced down; the verbs were made to say what they reclaim and whether they're reversible.
