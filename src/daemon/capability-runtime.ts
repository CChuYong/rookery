import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  compileClaudeCapabilities,
  type ClaudeCapabilityPlan,
  type ClaudeRuntimeLaunchOptions,
  type ClaudeSecretBinding,
} from "../core/claude-capabilities.js";
import { validateCapabilityPack } from "../core/capabilities/manifest.js";
import type { ResolvedAgentCapabilities, SecretRef } from "../core/capabilities/types.js";

export interface CapabilityRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  getSecretValue(packInstanceId: string, key: string): string | undefined;
}

interface PackSource {
  packInstanceId: string;
  packId: string;
  digest: string;
  sourcePath: string;
}

function sourceDirName(packInstanceId: string): string {
  return Buffer.from(packInstanceId).toString("hex");
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, value, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

// Claude's plugin MCP loader currently discovers a stdio server's `cwd` field but does not apply
// it when spawning the command. A tiny generated Node launcher makes the pack contract explicit and
// cross-platform: all public process metadata stays in immutable files, while secret aliases remain
// on the MCP entry and are expanded into the inherited child environment by Claude.
const STDIO_LAUNCHER = `import fs from "node:fs";
import { spawn } from "node:child_process";

const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const child = spawn(config.command, config.args, {
  cwd: config.cwd,
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => { try { child.kill(signal); } catch { /* already gone */ } });
}
child.once("error", (error) => {
  process.stderr.write(\`Rookery MCP launcher failed: \${error instanceof Error ? error.message : String(error)}\\n\`);
  process.exitCode = 1;
});
child.once("exit", (code) => { process.exitCode = code ?? 1; });
`;

function materializeMcpConfig(
  config: ClaudeCapabilityPlan["plugins"][number]["mcpConfig"],
  stagingPluginRoot: string,
  finalPluginRoot: string,
): ClaudeCapabilityPlan["plugins"][number]["mcpConfig"] {
  let wroteLauncher = false;
  const mcpServers = Object.fromEntries(Object.entries(config.mcpServers).map(([name, raw]) => {
    const server = raw as Record<string, unknown>;
    if (server.type !== "stdio" || typeof server.cwd !== "string") return [name, server];

    const runtimeDir = path.join(".rookery", "mcp-runtime");
    const configName = `${Buffer.from(name).toString("hex")}.json`;
    const stagingConfig = path.join(stagingPluginRoot, runtimeDir, configName);
    const finalConfig = path.join(finalPluginRoot, runtimeDir, configName);
    const stagingLauncher = path.join(stagingPluginRoot, runtimeDir, "stdio-launcher.mjs");
    const finalLauncher = path.join(finalPluginRoot, runtimeDir, "stdio-launcher.mjs");
    if (!wroteLauncher) {
      writeText(stagingLauncher, STDIO_LAUNCHER);
      wroteLauncher = true;
    }

    const { command, args, cwd, ...rest } = server;
    writeJson(stagingConfig, {
      command,
      args: Array.isArray(args) ? args : [],
      cwd,
    });
    return [name, {
      ...rest,
      type: "stdio",
      command: process.execPath,
      args: [finalLauncher, finalConfig],
    }];
  }));
  return { mcpServers };
}

function hardenTree(root: string): void {
  const visit = (entry: string): void => {
    const stat = fs.statSync(entry);
    if (stat.isDirectory()) {
      fs.chmodSync(entry, 0o700);
      for (const name of fs.readdirSync(entry)) visit(path.join(entry, name));
      return;
    }
    fs.chmodSync(entry, (stat.mode & 0o111) !== 0 ? 0o700 : 0o600);
  };
  visit(root);
}

function packSources(capabilities: ResolvedAgentCapabilities): PackSource[] {
  const sources = new Map<string, PackSource>();
  for (const entry of [...capabilities.instructions, ...capabilities.skills, ...capabilities.mcpServers]) {
    const source = {
      packInstanceId: entry.packInstanceId,
      packId: entry.packId,
      digest: entry.digest,
      sourcePath: entry.sourcePath,
    };
    const previous = sources.get(entry.packInstanceId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(source)) {
      throw new Error(`capability pack ${entry.packInstanceId} has inconsistent runtime sources`);
    }
    sources.set(entry.packInstanceId, source);
  }
  return [...sources.values()].sort((a, b) => a.packInstanceId.localeCompare(b.packInstanceId));
}

function refValue(
  binding: ClaudeSecretBinding,
  options: CapabilityRuntimeOptions,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const ref: SecretRef = binding.ref;
  return ref.source === "rookery-secret"
    ? options.getSecretValue(binding.packInstanceId, ref.key)
    : env[ref.name];
}

export class CapabilityRuntime {
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    private readonly home: string,
    private readonly options: CapabilityRuntimeOptions,
  ) {
    this.env = options.env ?? process.env;
  }

  materializeClaude(capabilities: ResolvedAgentCapabilities): ClaudeRuntimeLaunchOptions {
    if (capabilities.blocked) {
      throw new Error(`capability runtime ${capabilities.revision} is blocked`);
    }
    const sources = packSources(capabilities);
    if (sources.length === 0) {
      return { revision: capabilities.revision, plugins: [], env: {}, diagnostics: [] };
    }

    const runtimeParent = path.join(this.home, "capability-runtime");
    const finalRoot = path.join(runtimeParent, capabilities.revision);
    const marker = path.join(finalRoot, ".complete.json");
    if (!fs.existsSync(marker)) this.createRevision(capabilities, sources, runtimeParent, finalRoot);
    if (!fs.existsSync(marker)) throw new Error(`capability runtime ${capabilities.revision} is incomplete`);

    const plan = compileClaudeCapabilities(
      capabilities,
      (instanceId) => path.join(finalRoot, "source", sourceDirName(instanceId)),
    );
    return this.launchOptions(plan, finalRoot);
  }

  private createRevision(
    capabilities: ResolvedAgentCapabilities,
    sources: PackSource[],
    runtimeParent: string,
    finalRoot: string,
  ): void {
    fs.mkdirSync(runtimeParent, { recursive: true, mode: 0o700 });
    fs.chmodSync(runtimeParent, 0o700);
    const stagingRoot = path.join(runtimeParent, `.tmp-${capabilities.revision}-${process.pid}-${randomUUID()}`);
    try {
      fs.mkdirSync(stagingRoot, { recursive: false, mode: 0o700 });
      for (const source of sources) {
        const destination = path.join(stagingRoot, "source", sourceDirName(source.packInstanceId));
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        // Dereference pack-contained links so the immutable runtime never points back at mutable source bytes.
        fs.cpSync(source.sourcePath, destination, { recursive: true, dereference: true, preserveTimestamps: false });
        const copied = validateCapabilityPack(destination);
        if (copied.digest !== source.digest) {
          throw new Error(`capability pack ${source.packId} digest changed after trust`);
        }
      }

      const finalPlan = compileClaudeCapabilities(
        capabilities,
        (instanceId) => path.join(finalRoot, "source", sourceDirName(instanceId)),
      );
      for (const plugin of finalPlan.plugins) {
        const pluginRoot = path.join(stagingRoot, "claude", plugin.pluginDirName);
        writeJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"), {
          name: plugin.pluginName,
          version: "1.0.0",
          description: `Rookery managed capability pack ${plugin.packId}`,
        });
        const skills = capabilities.skills.filter((skill) => skill.packInstanceId === plugin.packInstanceId);
        for (const skill of skills) {
          const sourceRoot = path.join(stagingRoot, "source", sourceDirName(skill.packInstanceId));
          const destination = path.join(pluginRoot, "skills", skill.id);
          fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
          fs.cpSync(path.join(sourceRoot, skill.path), destination, { recursive: true, dereference: true, preserveTimestamps: false });
        }
        if (Object.keys(plugin.mcpConfig.mcpServers).length > 0) {
          const finalPluginRoot = path.join(finalRoot, "claude", plugin.pluginDirName);
          writeJson(
            path.join(pluginRoot, ".mcp.json"),
            materializeMcpConfig(plugin.mcpConfig, pluginRoot, finalPluginRoot),
          );
        }
      }
      writeJson(path.join(stagingRoot, ".complete.json"), {
        schemaVersion: 1,
        revision: capabilities.revision,
        packs: sources.map((source) => ({
          packInstanceId: source.packInstanceId,
          packId: source.packId,
          digest: source.digest,
        })),
      });
      hardenTree(stagingRoot);
      try {
        fs.renameSync(stagingRoot, finalRoot);
      } catch (error) {
        if (!fs.existsSync(path.join(finalRoot, ".complete.json"))) throw error;
      }
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
  }

  private launchOptions(plan: ClaudeCapabilityPlan, finalRoot: string): ClaudeRuntimeLaunchOptions {
    const env: Record<string, string> = {};
    for (const binding of plan.secretBindings) {
      const value = refValue(binding, this.options, this.env);
      if (value === undefined || value === "") {
        const label = binding.ref.source === "rookery-secret" ? binding.ref.key : binding.ref.name;
        throw new Error(`capability runtime requirement is unavailable: ${label}`);
      }
      env[binding.envName] = value;
    }
    const instructionSections = plan.instructions.map((instruction) => {
      const content = fs.readFileSync(instruction.path, "utf8").trim();
      return `### ${instruction.label}\n${content}`;
    });
    return {
      revision: plan.revision,
      plugins: plan.plugins.map((plugin) => ({
        type: "local" as const,
        path: path.join(finalRoot, "claude", plugin.pluginDirName),
      })),
      env,
      ...(instructionSections.length > 0
        ? { systemPromptAppend: `## Rookery managed capability instructions\n\n${instructionSections.join("\n\n")}` }
        : {}),
      diagnostics: plan.diagnostics,
    };
  }
}
