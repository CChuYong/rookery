// Launch only against the explicit temporary fixture server; no real daemon fallback.
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { app } = require("electron");
const root = path.resolve(__dirname, "../../..");
const dir = process.env.ROOKERY_IMAGE_FIXTURE_DIR;
if (!dir || !fs.existsSync(path.join(dir, "fixture-server.json")))
  throw Error(
    "Start the isolated image fixture first and set ROOKERY_IMAGE_FIXTURE_DIR",
  );
const fixture = JSON.parse(
  fs.readFileSync(path.join(dir, "fixture-server.json"), "utf8"),
);
const debugPort = process.env.ROOKERY_IMAGE_FIXTURE_DEBUG_PORT || "19239";
if (
  !/^\d+$/.test(debugPort) ||
  Number(debugPort) < 1024 ||
  Number(debugPort) > 65535
)
  throw Error("Invalid fixture debug port");
app.commandLine.appendSwitch("remote-debugging-port", debugPort);
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
for (const part of [
  "electron-data",
  "electron-session",
  "logs",
  "claude",
  "codex",
])
  fs.mkdirSync(path.join(dir, part), { recursive: true });
app.setPath("userData", path.join(dir, "electron-data"));
app.setPath("sessionData", path.join(dir, "electron-session"));
app.setAppLogsPath(path.join(dir, "logs"));
Object.assign(process.env, {
  ROOKERY_HOST: "127.0.0.1",
  ROOKERY_DEBUG_PORT: debugPort,
  ROOKERY_HOME: path.join(dir, "home"),
  ROOKERY_PORT: String(fixture.port),
  ROOKERY_DAEMON_ENTRY: path.join(dir, "no-real-daemon.cjs"),
  ROOKERY_ENV_FILE: path.join(dir, "absent.env"),
  CODEX_HOME: path.join(dir, "codex"),
  CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
});
// These inherited switches can select a dev renderer, remote debugger, or injected Node startup code.
for (const key of [
  "ELECTRON_RENDERER_URL",
  "ELECTRON_REMOTE_DEBUGGING_PORT",
  "ELECTRON_REMOTE_DEBUGGING_ADDRESS",
  "NODE_OPTIONS",
  "NODE_INSPECT_RESUME_ON_START",
  "VSCODE_INSPECTOR_OPTIONS",
])
  delete process.env[key];
for (const key of Object.keys(process.env))
  if (
    /^(ANTHROPIC_|OPENAI_|SLACK_|ROOKERY_CAP_SECRET_|CLAUDE_CODE_OAUTH)/.test(
      key,
    )
  )
    delete process.env[key];
// Refuse to attach to an unrelated process that happens to occupy the fixture port.
fetch(`http://127.0.0.1:${fixture.port}/health`, {
  signal: AbortSignal.timeout(2000),
})
  .then((response) => response.json())
  .then((health) => {
    if (
      health.fixture !== "rookery-images" ||
      path.resolve(health.dir) !== path.resolve(dir)
    )
      throw Error("Expected the isolated image fixture server");
    return import(
      pathToFileURL(path.join(root, "apps/desktop/out/main/index.js")).href
    );
  })
  .catch((error) => {
    console.error(String(error));
    app.quit();
  });
