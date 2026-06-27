import { useEffect, useRef } from "react";

// Shared modal keyboard handling: Esc to close + Cmd/Ctrl+Enter to submit. Callbacks are kept fresh via a ref (the listener is registered once per enabled).
// When enabled=false, don't register (so an always-mounted modal that's closed doesn't intercept the global Esc).
export function useModalKeys(onClose: () => void, onSubmit?: () => void, enabled = true): void {
  const cb = useRef({ onClose, onSubmit });
  cb.current = { onClose, onSubmit };
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cb.current.onClose();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        cb.current.onSubmit?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
