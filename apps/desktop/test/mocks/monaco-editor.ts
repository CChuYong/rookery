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

class FakeDiffEditor {
  private model: { original: { dispose(): void }; modified: { dispose(): void } } | null = null;
  setModel(m: { original: { dispose(): void }; modified: { dispose(): void } }): void { this.model = m; }
  getModel(): { original: { dispose(): void }; modified: { dispose(): void } } | null { return this.model; }
  dispose(): void {}
}
export const __diffInstances: FakeDiffEditor[] = [];

export const editor = {
  EditorOption: { readOnly: 91 },
  create: (_host: unknown, _opts?: unknown): FakeEditor => {
    const e = new FakeEditor();
    __instances.push(e);
    return e;
  },
  createDiffEditor: (_host: unknown, _opts?: unknown): FakeDiffEditor => {
    const e = new FakeDiffEditor();
    __diffInstances.push(e);
    return e;
  },
  createModel: (value: string, _lang?: string): { value: string; dispose(): void } => ({ value, dispose() {} }),
};

export const languages = { getLanguages: (): Array<{ id: string; extensions?: string[]; filenames?: string[] }> => [] };
export const KeyMod = { CtrlCmd: 1 };
export const KeyCode = { KeyS: 2 };
