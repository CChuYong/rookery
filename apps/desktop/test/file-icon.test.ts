import { describe, it, expect } from "vitest";
import { fileIcon, DEFAULT_FILE_ICON } from "../src/renderer/lib/fileIcon.js";

describe("fileIcon", () => {
  it("maps source extensions to vscode-icons names", () => {
    expect(fileIcon("Main.kt")).toBe("vscode-icons:file-type-kotlin");
    expect(fileIcon("/r/src/App.tsx")).toBe("vscode-icons:file-type-reactts");
    expect(fileIcon("util.py")).toBe("vscode-icons:file-type-python");
    expect(fileIcon("lib.rs")).toBe("vscode-icons:file-type-rust");
    expect(fileIcon("api.ts")).toBe("vscode-icons:file-type-typescript");
  });
  it("maps json/markdown/images", () => {
    expect(fileIcon("package.json")).toBe("vscode-icons:file-type-json");
    expect(fileIcon("README.md")).toBe("vscode-icons:file-type-markdown");
    expect(fileIcon("logo.png")).toBe("vscode-icons:file-type-image");
  });
  it("is case-insensitive on extension", () => {
    expect(fileIcon("Logo.PNG")).toBe("vscode-icons:file-type-image");
    expect(fileIcon("Build.KTS")).toBe("vscode-icons:file-type-kotlin");
  });
  it("handles dotfiles and special filenames", () => {
    expect(fileIcon(".gitignore")).toBe("vscode-icons:file-type-git");
    expect(fileIcon(".env")).toBe("vscode-icons:file-type-dotenv");
    expect(fileIcon(".env.local")).toBe("vscode-icons:file-type-dotenv");
    expect(fileIcon("Dockerfile")).toBe("vscode-icons:file-type-docker");
  });
  it("falls back to default-file for unknown extensions", () => {
    expect(fileIcon("mystery.zzz")).toBe(DEFAULT_FILE_ICON);
    expect(fileIcon("Makefile")).toBe(DEFAULT_FILE_ICON);
  });
});
