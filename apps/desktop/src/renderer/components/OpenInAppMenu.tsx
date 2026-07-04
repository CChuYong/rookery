import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown, AppWindow, Folder, SquareTerminal, Code, Check } from "lucide-react";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";
import { toast } from "../store/toasts.js";
import type { DetectedApp } from "../types/rookery.js";

const LS_KEY = "rookery.openInApp"; // id of the last selected app

// Per-kind fallback icon (when the app icon dataURL is missing). The real app icon comes from main's app.getFileIcon.
function FallbackIcon({ kind, size = 15 }: { kind: DetectedApp["kind"]; size?: number }): JSX.Element {
  if (kind === "finder") return <Folder size={size} className="text-accent" />;
  if (kind === "terminal") return <SquareTerminal size={size} className="text-muted" />;
  return <Code size={size} className="text-muted" />;
}

function AppGlyph({ app, size }: { app: DetectedApp; size: number }): JSX.Element {
  return app.icon
    ? <img src={app.icon} alt="" style={{ width: size, height: size }} className="shrink-0 object-contain" />
    : <FallbackIcon kind={app.kind} size={size - 2} />;
}

// Open the current work root (cwd/worker worktree) directly in an installed IDE/Finder/Terminal.
// Split button: left = last-selected app icon (click = run immediately), right = dropdown (change app). The selection is remembered in localStorage.
// The root is freshly resolved right before launch (ws.resolveRoot) — to handle the case where the worker worktree is created asynchronously.
export function OpenInAppMenu({ subId, cwd }: { subId?: string | null; cwd?: string }): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [apps, setApps] = useState<DetectedApp[] | null>(null);
  const [selId, setSelId] = useState<string | null>(() => localStorage.getItem(LS_KEY));
  const menuRef = useRef<HTMLDivElement>(null);

  // Detect the app list once on mount (so the left button icon renders right away). Install state rarely changes.
  useEffect(() => { void window.rookery.apps.list().then(setApps).catch(() => setApps([])); }, []);
  // Escape closes the open dropdown.
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);
  // Focus the first app on open (audit #60 — reuses ContextMenu's precedent). `apps` is already fetched on mount
  // in the common case, but this also covers opening before that fetch resolves.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')?.focus();
  }, [open, apps]);
  // ArrowUp/Down roving across apps (audit #60 — same logic as ContextMenu.tsx).
  const onMenuKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const btns = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
    if (btns.length === 0) return;
    const idx = btns.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (idx + 1) % btns.length : (idx - 1 + btns.length) % btns.length;
    btns[next]?.focus();
  };

  // Selected app: the saved value if it's in the installed list, otherwise the default (first list item = first editor in the catalog).
  const selected = apps && apps.length > 0 ? (apps.find((a) => a.id === selId) ?? apps[0]) : null;

  // Remember the selection + resolve the root, then launch. Close when chosen from the dropdown.
  // Both a thrown rejection and a resolved { ok: false } (e.g. the app failed to launch) must surface — previously
  // both were swallowed silently, so a failed open looked identical to a successful one (#11).
  const choose = (id: string, closeAfter: boolean): void => {
    setSelId(id);
    localStorage.setItem(LS_KEY, id);
    void window.rookery.ws.resolveRoot({ subId: subId ?? undefined, cwd })
      .then((root) => (root ? window.rookery.apps.open(id, root) : undefined))
      .then((res) => { if (res && !res.ok) toast.error(t("openInAppMenu.openFailed")); })
      .catch(() => toast.error(t("openInAppMenu.openFailed")));
    if (closeAfter) setOpen(false);
  };

  // If there are no openable apps at all (almost never — Finder/Terminal always exist), hide the control entirely.
  if (apps !== null && apps.length === 0) return <></>;

  return (
    <div className="relative flex items-center">
      <div className="no-drag flex h-6 items-center overflow-hidden rounded-md border border-line bg-raised/40">
        <button
          onClick={() => selected && choose(selected.id, false)}
          aria-label={t("openInAppMenu.openCurrentFolder")}
          title={selected ? t("openInAppMenu.openInApp", { name: selected.name }) : t("openInAppMenu.openInOtherApp")}
          className="flex h-full w-6 items-center justify-center text-muted transition-colors hover:bg-raised hover:text-fg-dim"
        >
          {selected ? <AppGlyph app={selected} size={16} /> : <AppWindow size={14} />}
        </button>
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label={t("openInAppMenu.selectOtherApp")}
          aria-haspopup="menu"
          aria-expanded={open}
          title={t("openInAppMenu.selectOtherApp")}
          className={cn("flex h-full items-center gap-1 border-l border-line px-1.5 text-[10.5px] transition-colors", open ? "bg-accent/15 text-accent" : "text-muted hover:bg-raised hover:text-fg-dim")}
        >
          {/* short text label (audit #59) — the icon+chevron split button used to be unlabeled and read as a stray glyph in the header */}
          <span>{t("openInAppMenu.label")}</span>
          <ChevronDown size={11} />
        </button>
      </div>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div ref={menuRef} onKeyDown={onMenuKeyDown} role="menu" className="menu-pop absolute right-0 top-7 z-40 max-h-80 w-52 origin-top-right overflow-y-auto rounded-lg border border-line bg-raised p-1 shadow-xl">
            {apps === null && <div className="px-2 py-1.5 text-[12px] text-muted">{t("openInAppMenu.detectingApps")}</div>}
            {apps?.map((a) => (
              <button
                key={a.id}
                role="menuitemradio"
                aria-checked={selected?.id === a.id}
                onClick={() => choose(a.id, true)}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12.5px] text-fg-dim hover:bg-line/40"
              >
                <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center"><AppGlyph app={a} size={18} /></span>
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                {selected?.id === a.id && <Check size={13} className="shrink-0 text-accent" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
