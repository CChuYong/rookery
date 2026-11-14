// Lightweight fake of the `monaco-editor` package for tests. The real package can't be resolved under
// vitest/jsdom (its package.json exposes no Node-resolvable "main"/"exports", only a browser "module" entry),
// so vitest.config.ts aliases the bare specifier to this file for every renderer import during tests.
// It captures just enough of the API surface MonacoEditor/monacoLang use (create/getValue/setValue/
// onDidChangeModelContent/addCommand) to drive load/save flows; `__instances` lets tests reach into the
// most-recently-created fake editor (there's normally exactly one per mounted MonacoEditor).
class FakeEditor {
  private value = "";
  private changeCb: (() => void) | null = null;
  commandCb: (() => void) | null = null;
  readOnly = false;
  updateOptions(o: { readOnly?: boolean }): void { if (o.readOnly !== undefined) this.readOnly = o.readOnly; }
  getOption(id: number): unknown { return id === editor.EditorOption.readOnly ? this.readOnly : undefined; }
  getValue(): string { return this.value; }
  setValue(v: string): void { this.value = v; this.changeCb?.(); }
  onDidChangeModelContent(cb: () => void): void { this.changeCb = cb; }
  addCommand(_keybinding: number, cb: () => void): void { this.commandCb = cb; }
  dispose(): void {}
}

export const __instances: FakeEditor[] = [];

export const editor = {
  EditorOption: { readOnly: 91 },
  create: (_host: unknown, _opts?: unknown): FakeEditor => {
    const e = new FakeEditor();
    __instances.push(e);
    return e;
  },
};

export const languages = { getLanguages: (): Array<{ id: string; extensions?: string[]; filenames?: string[] }> => [] };
export const KeyMod = { CtrlCmd: 1 };
export const KeyCode = { KeyS: 2 };
