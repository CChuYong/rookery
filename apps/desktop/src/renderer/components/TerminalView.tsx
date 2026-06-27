import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useT } from "../i18n/provider.js";

// One tab = one xterm instance. The PTY lives in main; here we only display/input. The PTY survives unmount (detach).
export function TerminalView({ id, onExit }: { id: string; onExit: (id: string) => void }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const t = useT();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Map the full ANSI palette onto the rookery @theme tokens (read live from :root — globals.css is loaded by now) so
    // git/test/ls output speaks run/pr/fail/nochg/coral instead of xterm's stock saturated ANSI.
    const css = getComputedStyle(document.documentElement);
    const tok = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;
    const ink = tok("--color-ink", "#0b0d12");
    const fg = tok("--color-fg", "#e7e9ee");
    const fgDim = tok("--color-fg-dim", "#aab1c0");
    const muted = tok("--color-muted", "#79808f");
    const accent = tok("--color-accent", "#f97362");
    const accentHi = tok("--color-accent-hi", "#fb8472");
    const run = tok("--color-run", "#f5b544");
    const pr = tok("--color-pr", "#46c073");
    const fail = tok("--color-fail", "#ef5350");
    const nochg = tok("--color-nochg", "#5b8def");
    const term = new Terminal({
      fontFamily: "'Geist Mono Variable', ui-monospace, monospace",
      fontSize: 12.5,
      theme: {
        background: ink, foreground: fg, cursor: accent, cursorAccent: ink,
        selectionBackground: "rgba(249, 115, 98, 0.22)", // coral wash
        black: tok("--color-surface", "#13161d"), brightBlack: muted,
        red: fail, brightRed: fail,
        green: pr, brightGreen: pr,
        yellow: run, brightYellow: run,
        blue: nochg, brightBlue: nochg,
        magenta: accent, brightMagenta: accentHi,
        cyan: "#56c7c0", brightCyan: "#7ad6cf",
        white: fgDim, brightWhite: fg,
      },
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const offData = window.rookery.term.onData((tid, data) => { if (tid === id) term.write(data); });
    const offExit = window.rookery.term.onExit((tid, code) => {
      if (tid !== id) return;
      term.write(`\r\n\x1b[2m${t("terminalView.processExited", { code })}\x1b[0m\r\n`);
      onExit(id);
    });
    term.onData((d) => window.rookery.term.write(id, d));

    void window.rookery.term.attach(id).then(({ scrollback }) => {
      if (scrollback) term.write(scrollback);
      try { fit.fit(); window.rookery.term.resize(id, term.cols, term.rows); } catch { /* hidden */ }
    });

    const ro = new ResizeObserver(() => {
      try { fit.fit(); window.rookery.term.resize(id, term.cols, term.rows); } catch { /* hidden */ }
    });
    ro.observe(host);
    term.focus();

    return () => {
      ro.disconnect();
      offData();
      offExit();
      window.rookery.term.detach(id);
      term.dispose();
    };
  }, [id, onExit, t]);

  return <div ref={hostRef} className="h-full w-full" />;
}
