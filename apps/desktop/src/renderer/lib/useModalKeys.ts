import { useEffect, useRef } from "react";

type ModalKeyBaseOptions = {
  onSubmit?: () => void;
  enabled?: boolean;
};

// Every modal must make its Escape policy explicit. Draft-bearing forms use "ignore" so an
// accidental keypress cannot unmount local state; confirmations can opt into the familiar close behavior.
export type ModalKeyOptions = ModalKeyBaseOptions & (
  | { escape: "close"; onEscape: () => void }
  | { escape: "ignore"; onEscape?: never }
);

type ActiveModal = { readOptions: () => ModalKeyOptions };

const activeModals = new Map<number, ActiveModal>();
let nextModalId = 0;
let listening = false;

function topmostModal(): ActiveModal | undefined {
  let topId = -1;
  let top: ActiveModal | undefined;
  for (const [id, modal] of activeModals) {
    if (id > topId) {
      topId = id;
      top = modal;
    }
  }
  return top;
}

function handleModalKey(event: KeyboardEvent): void {
  const options = topmostModal()?.readOptions();
  if (!options) return;

  if (event.key === "Escape") {
    // Escape belongs to the topmost modal even when its policy is to ignore it. This prevents an
    // underlying dialog or an app-level shortcut from handling the same key and discarding state.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (options.escape === "close") options.onEscape();
    return;
  }

  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && options.onSubmit) {
    event.preventDefault();
    event.stopImmediatePropagation();
    options.onSubmit();
  }
}

function startListening(): void {
  if (listening) return;
  window.addEventListener("keydown", handleModalKey);
  listening = true;
}

function stopListeningIfIdle(): void {
  if (!listening || activeModals.size > 0) return;
  window.removeEventListener("keydown", handleModalKey);
  listening = false;
}

// Shared topmost-modal keyboard handling. Callbacks stay fresh through a ref while registration changes
// only when enabled changes, so ordinary form edits do not churn the global listener.
export function useModalKeys(options: ModalKeyOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const idRef = useRef(0);
  if (idRef.current === 0) idRef.current = ++nextModalId;

  useEffect(() => {
    if (options.enabled === false) return;
    const id = idRef.current;
    activeModals.set(id, { readOptions: () => optionsRef.current });
    startListening();
    return () => {
      activeModals.delete(id);
      stopListeningIfIdle();
    };
  }, [options.enabled]);
}
