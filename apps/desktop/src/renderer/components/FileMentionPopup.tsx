import { useRef } from "react";
import { Icon } from "@iconify/react";
import { useScrollActiveIntoView } from "../lib/focus.js";
import { useT } from "../i18n/provider.js";
import { fileIcon, FOLDER_ICON } from "../lib/fileIcon.js";
import type { BrowseEntry } from "../types/rookery.js";
import { cn } from "../lib/cn.js";
import { MENU_ITEM, MENU_ITEM_ACTIVE, MENU_SURFACE } from "../lib/ui-tokens.js";

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
// role=listbox/option + ids so the editor can point aria-activedescendant at the highlight; the highlighted row is kept
// in view while the arrow keys move it (audit #70).
export function FileMentionPopup({
  id,
  entries,
  sel,
  onHover,
  onPick,
}: {
  id?: string;
  entries: BrowseEntry[];
  sel: number;
  onHover: (i: number) => void;
  onPick: (entry: BrowseEntry) => void;
}): JSX.Element {
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);
  useScrollActiveIntoView(listRef, sel);
  return (
    <div ref={listRef} id={id} role="listbox" aria-label={t("composer.filesLabel")} className={cn("pop-in absolute bottom-full left-0 z-30 mb-2 max-h-64 w-[min(420px,100%)] origin-bottom-left overflow-y-auto", MENU_SURFACE)}>
      {entries.map((e, i) => (
        <button
          key={e.name}
          id={id ? `${id}-${i}` : undefined}
          role="option"
          aria-selected={i === sel}
          tabIndex={-1}
          type="button"
          className={cn("flex w-full items-center gap-2 px-2.5 py-1.5 text-left", MENU_ITEM, i === sel && MENU_ITEM_ACTIVE)}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(ev) => {
            ev.preventDefault(); // keep editor focus
            onPick(e);
          }}
        >
          <Icon icon={e.isDir ? FOLDER_ICON : fileIcon(e.name)} width={15} height={15} className="shrink-0" />
          <span className="truncate text-ui text-fg">
            {e.name}
            {e.isDir ? "/" : ""}
          </span>
          {!e.isDir && e.size !== undefined && <span className="ml-auto shrink-0 text-meta text-muted">{humanSize(e.size)}</span>}
        </button>
      ))}
    </div>
  );
}
