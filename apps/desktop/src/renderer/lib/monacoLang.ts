import * as monaco from "monaco-editor";
import { baseName } from "./path.js";

// File path → Monaco language id. Instead of a hardcoded extension map, query the extensions/filenames
// metadata of every language registered in Monaco (metadata is registered immediately, only the tokenizer is lazy). → automatically
// recognizes every language Monaco knows, such as kotlin, swift, java, c++. Falls back to plaintext if none matches.
export function langOf(path: string): string {
  const name = baseName(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot) : "";
  for (const l of monaco.languages.getLanguages()) {
    if (ext && l.extensions?.some((e) => e.toLowerCase() === ext)) return l.id;
    if (l.filenames?.some((f) => f.toLowerCase() === name)) return l.id; // Dockerfile, Makefile, etc.
  }
  return "plaintext";
}
