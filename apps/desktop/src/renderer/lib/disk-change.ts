// Decision logic (pure) for when the fs watcher reports a file change (fs:changed). MonacoEditor uses it decoupled from the monaco instance so it stays testable.
// - ignore: an echo of our own save, or identical to the baseline → do nothing (in particular, prevents a "Changed on disk" false positive after Cmd+S).
// - adopt:  external change while the buffer is clean → silently reload with the disk contents.
// - banner: buffer is dirty but the disk really changed externally → "Changed on disk" banner.
export type DiskChangeAction = "ignore" | "adopt" | "banner";

export function decideDiskChange(args: {
  disk: string; // current disk contents
  lastWritten: string | null; // the contents we last wrote (recorded synchronously on Cmd+S → blocks the echo race)
  buffer: string; // editor's current buffer
  saved: string; // the disk baseline as we know it
}): DiskChangeAction {
  // An echo of what we just wrote coming back unchanged → ignore (even before the save resolves and the baseline is updated).
  if (args.disk === args.lastWritten) return "ignore";
  // Disk equals the baseline → not a real external change (spurious event) → ignore.
  if (args.disk === args.saved) return "ignore";
  // Changed externally: if the buffer is clean, silently adopt; if dirty, show a banner since we could lose work.
  return args.buffer === args.saved ? "adopt" : "banner";
}
