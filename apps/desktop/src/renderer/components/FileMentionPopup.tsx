import { Icon } from "@iconify/react";
import { fileIcon, FOLDER_ICON } from "../lib/fileIcon.js";
import type { BrowseEntry } from "../types/rookery.js";

// Format bytes as a human-readable size (right side of the file row). Trims trailing zero/decimal.
function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

// Chat @ path autocomplete popup (same position/tone as the slash popup). Icon + name (folders get a trailing /) + file size.
export function FileMentionPopup({
  entries,
  sel,
  onHover,
  onPick,
}: {
  entries: BrowseEntry[];
  sel: number;
  onHover: (i: number) => void;
  onPick: (entry: BrowseEntry) => void;
}): JSX.Element {
  return (
    <div className="pop-in absolute bottom-full left-0 z-30 mb-2 max-h-64 w-[min(420px,100%)] origin-bottom-left overflow-y-auto rounded-lg border border-line bg-raised p-1 shadow-xl">
      {entries.map((e, i) => (
        <button
          key={e.name}
          type="button"
          className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left ${i === sel ? "bg-accent/15" : "hover:bg-line/40"}`}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(ev) => {
            ev.preventDefault(); // keep editor focus
            onPick(e);
          }}
        >
          <Icon icon={e.isDir ? FOLDER_ICON : fileIcon(e.name)} width={15} height={15} className="shrink-0" />
          <span className="truncate text-[12px] text-fg">
            {e.name}
            {e.isDir ? "/" : ""}
          </span>
          {!e.isDir && e.size !== undefined && <span className="ml-auto shrink-0 text-[11px] text-muted">{humanSize(e.size)}</span>}
        </button>
      ))}
    </div>
  );
}
