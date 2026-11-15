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
    // git/test/ls output speaks run/pr/fail/nochg/orange instead of xterm's stock saturated ANSI.
    const css = getComputedStyle(document.documentElement);
    const tok = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;
    const ink = tok("--color-ink", "#0f0f0f");
    const fg = tok("--color-fg", "#e8e8e8");
    const fgDim = tok("--color-fg-dim", "#b7b7b7");
    const muted = tok("--color-muted", "#868686");
    const accent = tok("--color-accent", "#f97c3d");
    const accentHi = tok("--color-accent-hi", "#ff9661");
    const run = tok("--color-run", "#6db0f4");
    const pr = tok("--color-pr", "#6fc884");
    const fail = tok("--color-fail", "#f27166");
    const nochg = tok("--color-nochg", "#819bb7");
    const term = new Terminal({
      fontFamily: "'Geist Mono Variable', ui-monospace, monospace",
      fontSize: 12.5,
      theme: {
        background: ink, foreground: fg, cursor: accent, cursorAccent: ink,
        selectionBackground: "rgba(249, 124, 61, 0.28)", // orange wash
        black: tok("--color-surface", "#161616"), brightBlack: muted,
        red: fail, brightRed: fail,
        green: pr, brightGreen: pr,
        yellow: accentHi, brightYellow: accentHi,
        blue: run, brightBlue: run,
        magenta: accent, brightMagenta: accentHi,
        cyan: "#64c3c3", brightCyan: "#8adbdb",
        white: fgDim, brightWhite: fg,
      },
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    // The dock hides a terminal by sizing its group to 0 (no display:none). Fitting then yields 1 row, and resizing
    // the PTY to that makes full-screen programs (vim, less, htop) redraw into a single line on every hide. Skip
    // fit+resize until the host has room again; the ResizeObserver fires when it does (review fix 2).
    const hasRoom = (): boolean => host.clientWidth > 0 && host.clientHeight > 0;
    const fitAndResize = (): void => {
      if (!hasRoom()) return;
      try { fit.fit(); window.rookery.term.resize(id, term.cols, term.rows); } catch { /* hidden */ }
    };
    if (hasRoom()) fit.fit();

    const offData = window.rookery.term.onData((tid, data) => { if (tid === id) term.write(data); });
    const offExit = window.rookery.term.onExit((tid, code) => {
      if (tid !== id) return;
      term.write(`\r\n\x1b[2m${t("terminalView.processExited", { code })}\x1b[0m\r\n`);
      onExit(id);
    });
    term.onData((d) => window.rookery.term.write(id, d));

    void window.rookery.term.attach(id).then(({ scrollback }) => {
      if (scrollback) term.write(scrollback);
      fitAndResize();
    });

    const ro = new ResizeObserver(fitAndResize);
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

  // data-term-id: lets the Cmd/Ctrl+W handler find the focused terminal (review fix 4).
  return <div ref={hostRef} data-term-id={id} className="h-full w-full" />;
}
