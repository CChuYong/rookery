// reduced-motion-aware smooth scroll — use only for discrete actions (pin button click, a just-sent message).
// Do NOT use on the high-frequency token-follow path (smooth lags the caret → there, keep assigning el.scrollTop directly).
function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

export function scrollToBottom(el: HTMLElement): void {
  const top = el.scrollHeight;
  if (typeof el.scrollTo === "function") {
    el.scrollTo({ top, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  } else {
    el.scrollTop = top; // jsdom/legacy fallback
  }
}
