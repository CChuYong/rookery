import { describe, it, expect } from "vitest";
import { parseArgs, resolveEnvFilePath, formatProcessError } from "../src/index.js";

describe("parseArgs", () => {
  it("defaults to cli", () => {
    expect(parseArgs([])).toEqual({ command: "cli" });
  });
  it("recognizes daemon", () => {
    expect(parseArgs(["daemon"])).toEqual({ command: "daemon" });
  });
  it("treats unknown commands as cli", () => {
    expect(parseArgs(["chat"])).toEqual({ command: "cli" });
  });
  it("parses --provider codex (finding [16])", () => {
    expect(parseArgs(["--provider", "codex"])).toEqual({ command: "cli", provider: "codex" });
    expect(parseArgs(["--provider=codex"])).toEqual({ command: "cli", provider: "codex" });
  });
  it("ignores an invalid --provider value (no provider field)", () => {
    expect(parseArgs(["--provider", "bogus"])).toEqual({ command: "cli" });
  });
});

describe("resolveEnvFilePath (CLI-ENVFILE)", () => {
  it("defaults to the repo .env one level above dist/", () => {
    expect(resolveEnvFilePath("/rookery/dist/index.js", {})).toBe("/rookery/.env");
  });
  it("honors the ROOKERY_ENV_FILE override", () => {
    expect(resolveEnvFilePath("/rookery/dist/index.js", { ROOKERY_ENV_FILE: "/custom/env" })).toBe("/custom/env");
  });
});

describe("formatProcessError (unhandled rejection/exception guard)", () => {
  it("includes the kind and the error's stack/message", () => {
    const out = formatProcessError("unhandledRejection", new Error("boom"));
    expect(out).toContain("unhandledRejection");
    expect(out).toContain("boom");
  });
  it("stringifies a non-Error reason", () => {
    expect(formatProcessError("uncaughtException", "weird")).toContain("weird");
  });
});
