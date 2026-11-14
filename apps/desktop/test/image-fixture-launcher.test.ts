import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL, URL as NodeURL } from "node:url";
import vm from "node:vm";
import { expect, it, vi } from "vitest";
it("pins the checked fixture host, built renderer and debug endpoint despite conflicting ambient variables", async () => {
  const filename = fileURLToPath(
    new NodeURL("../../../scripts/demo/images/launcher.cjs", import.meta.url),
  );
  // Execute all launcher logic with only the final Electron-main import boundary replaced.
  const source = readFileSync(filename, "utf8").replace(
    /\bimport\(/g,
    "importMain(",
  );
  const env: Record<string, string> = {
    ROOKERY_IMAGE_FIXTURE_DIR: "/tmp/launcher-test",
    ROOKERY_HOST: "other.invalid",
    ROOKERY_HOME: "/user/home",
    ROOKERY_PORT: "8787",
    ROOKERY_DEBUG_PORT: "7777",
    ELECTRON_RENDERER_URL: "http://other.invalid/ui",
    ELECTRON_REMOTE_DEBUGGING_PORT: "6666",
    NODE_OPTIONS: "--inspect=0.0.0.0:5555",
    ANTHROPIC_API_KEY: "synthetic-secret",
  };
  const switches: Array<[string, string]> = [];
  const importMain = vi.fn(async () => ({}));
  const app = {
    commandLine: {
      appendSwitch: (key: string, value: string) => switches.push([key, value]),
    },
    setPath: vi.fn(),
    setAppLogsPath: vi.fn(),
    quit: vi.fn(),
  };
  const fetch = vi.fn(async () => ({
    json: async () => ({
      fixture: "rookery-images",
      dir: "/tmp/launcher-test",
    }),
  }));
  vm.runInNewContext(source, {
    __dirname: path.dirname(filename),
    process: { env },
    require: (name: string) =>
      name === "electron"
        ? { app }
        : name === "node:fs"
          ? {
              existsSync: () => true,
              readFileSync: () => JSON.stringify({ port: 18989 }),
              mkdirSync: () => {},
            }
          : name === "node:path"
            ? path
            : { pathToFileURL },
    fetch,
    AbortSignal: { timeout: () => undefined },
    console,
    importMain,
  });
  await vi.waitFor(() => expect(importMain).toHaveBeenCalledOnce());
  expect(env.ROOKERY_HOST).toBe("127.0.0.1");
  expect(env.ROOKERY_PORT).toBe("18989");
  expect(env.ROOKERY_DEBUG_PORT).toBe("19239");
  expect(env.ELECTRON_RENDERER_URL).toBeUndefined();
  expect(env.ELECTRON_REMOTE_DEBUGGING_PORT).toBeUndefined();
  expect(env.NODE_OPTIONS).toBeUndefined();
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(switches).toContainEqual(["remote-debugging-address", "127.0.0.1"]);
  expect(switches).toContainEqual(["remote-debugging-port", "19239"]);
  expect(fetch).toHaveBeenCalledWith(
    "http://127.0.0.1:18989/health",
    expect.anything(),
  );
});
