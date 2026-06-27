import { useRef } from "react";

// Gate that fires the list-row appearance animation only for "genuinely new ids".
// The returned isNew(id) is true the first time an id is seen (+records it), false afterwards.
// ⚠️ MessageList/ToolGroup/RepoTree key rows by array index and replace the whole array
// (seedHistory) on reconnect, so naively wiring up a mount-fired appearance causes a flash-storm of the entire list on every reconnect.
// Gating through this hook means already-seen ids are not animated again.
// seed: pre-register the ids already on screen at first paint as "seen" (suppresses the initial transcript).
export function useSeenIds(seed?: readonly string[]): (id: string) => boolean {
  const seen = useRef<Set<string>>(undefined as unknown as Set<string>);
  if (seen.current === undefined) seen.current = new Set(seed);
  const isNew = useRef<(id: string) => boolean>(undefined as unknown as (id: string) => boolean);
  if (isNew.current === undefined) {
    isNew.current = (id: string) => {
      if (seen.current.has(id)) return false;
      seen.current.add(id);
      return true;
    };
  }
  return isNew.current;
}
