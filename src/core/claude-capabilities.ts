import { createHash } from "node:crypto";
import path from "node:path";
import type {
  McpServerSpec,
  ResolvedAgentCapabilities,
  SecretRef,
} from "./capabilities/types.js";

export interface ClaudeSecretBinding {
  envName: string;
  packInstanceId: string;
  ref: SecretRef;
}

export interface ClaudePluginPlan {
  packInstanceId: string;
  packId: string;
  pluginName: string;
  pluginDirName: string;
  skills: Array<{ id: string; sourcePath: string }>;
  mcpConfig: { mcpServers: Record<string, Record<string, unknown>> };
}

export interface ClaudeCapabilityPlan {
  revision: string;
  instructions: Array<{ id: string; label: string; path: string }>;
  plugins: ClaudePluginPlan[];
  secretBindings: ClaudeSecretBinding[];
  diagnostics: string[];
}

export interface ClaudeRuntimeLaunchOptions {
  revision: string;
  plugins: Array<{ type: "local"; path: string }>;
  env: Record<string, string>;
  systemPromptAppend?: string;
  diagnostics: string[];
}

function safeName(value: string, separator: "_" | "-"): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, separator).replace(new RegExp(`^\\${separator}+|\\${separator}+$`, "g"), "");
}

function shortIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function secretIdentity(ref: SecretRef): string {
  return ref.source === "rookery-secret" ? `rookery-secret:${ref.key}` : `environment:${ref.name}`;
}

export function claudeSecretEnvName(packInstanceId: string, ref: SecretRef): string {
  const digest = createHash("sha256")
    .update(packInstanceId)
    .update("\0")
    .update(secretIdentity(ref))
    .digest("hex")
    .slice(0, 24)
    .toUpperCase();
  return `ROOKERY_CAP_SECRET_${digest}`;
}

function environmentReference(envName: string): string {
  return `\${${envName}}`;
}

function addSecretBinding(
  bindings: Map<string, ClaudeSecretBinding>,
  packInstanceId: string,
  ref: SecretRef,
): string {
  const envName = claudeSecretEnvName(packInstanceId, ref);
  bindings.set(envName, { envName, packInstanceId, ref });
  return environmentReference(envName);
}

function compileMcpServer(
  generatedName: string,
  packInstanceId: string,
  sourceRoot: string,
  spec: McpServerSpec,
  bindings: Map<string, ClaudeSecretBinding>,
  diagnostics: string[],
): Record<string, unknown> {
  if (spec.startupTimeoutSec !== undefined) {
    diagnostics.push(
      `Claude does not support a per-server startup timeout for ${generatedName}; startupTimeoutSec=${spec.startupTimeoutSec} was not applied.`,
    );
  }
  if (spec.enabledTools?.length) {
    diagnostics.push(`Claude does not support a portable MCP enabled-tools filter for ${generatedName}; enabledTools was not applied.`);
  }
  if (spec.disabledTools?.length) {
    diagnostics.push(`Claude does not support a portable MCP disabled-tools filter for ${generatedName}; disabledTools was not applied.`);
  }

  if (spec.transport === "stdio") {
    const env: Record<string, string> = { ...(spec.env ?? {}) };
    for (const [name, ref] of Object.entries(spec.secretEnv ?? {})) {
      env[name] = addSecretBinding(bindings, packInstanceId, ref);
    }
    return {
      type: "stdio",
      command: spec.command,
      ...(spec.args ? { args: spec.args } : {}),
      ...(spec.cwd ? { cwd: path.join(sourceRoot, spec.cwd) } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(spec.toolTimeoutSec !== undefined ? { timeout: spec.toolTimeoutSec * 1_000 } : {}),
    };
  }

  const headers: Record<string, string> = { ...(spec.headers ?? {}) };
  for (const [name, ref] of Object.entries(spec.secretHeaders ?? {})) {
    headers[name] = addSecretBinding(bindings, packInstanceId, ref);
  }
  if (spec.auth) {
    headers.Authorization = `Bearer ${addSecretBinding(bindings, packInstanceId, spec.auth.bearerToken)}`;
  }
  return {
    type: "http",
    url: spec.url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(spec.toolTimeoutSec !== undefined ? { timeout: spec.toolTimeoutSec * 1_000 } : {}),
  };
}

export function compileClaudeCapabilities(
  capabilities: ResolvedAgentCapabilities,
  sourceRootFor: (packInstanceId: string) => string,
): ClaudeCapabilityPlan {
  if (capabilities.blocked) {
    throw new Error(`capability runtime ${capabilities.revision} is blocked`);
  }

  const bindings = new Map<string, ClaudeSecretBinding>();
  const diagnostics: string[] = [];
  const grouped = new Map<string, { packId: string; skills: typeof capabilities.skills; mcpServers: typeof capabilities.mcpServers }>();
  const groupFor = (packInstanceId: string, packId: string) => {
    const existing = grouped.get(packInstanceId);
    if (existing) return existing;
    const created = { packId, skills: [], mcpServers: [] };
    grouped.set(packInstanceId, created);
    return created;
  };
  for (const skill of capabilities.skills) groupFor(skill.packInstanceId, skill.packId).skills.push(skill);
  for (const server of capabilities.mcpServers) groupFor(server.packInstanceId, server.packId).mcpServers.push(server);

  const instructions = capabilities.instructions.map((instruction) => ({
    id: instruction.id,
    label: `${instruction.packId}/${instruction.id}`,
    path: path.join(sourceRootFor(instruction.packInstanceId), instruction.path),
  }));
  const plugins = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([packInstanceId, group]) => {
      const suffix = shortIdentity(packInstanceId);
      const baseName = safeName(group.packId, "-") || "pack";
      const pluginName = `rookery-${baseName}-${suffix}`;
      const sourceRoot = sourceRootFor(packInstanceId);
      const mcpServers = Object.fromEntries(group.mcpServers
        .sort((a, b) => a.generatedName.localeCompare(b.generatedName))
        .map((server) => [
          server.generatedName,
          compileMcpServer(server.generatedName, packInstanceId, sourceRoot, server.spec, bindings, diagnostics),
        ]));
      return {
        packInstanceId,
        packId: group.packId,
        pluginName,
        pluginDirName: pluginName,
        skills: group.skills
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((skill) => ({ id: skill.id, sourcePath: path.join(sourceRoot, skill.path) })),
        mcpConfig: { mcpServers },
      };
    });

  return {
    revision: capabilities.revision,
    instructions,
    plugins,
    secretBindings: [...bindings.values()].sort((a, b) => a.envName.localeCompare(b.envName)),
    diagnostics: diagnostics.sort((a, b) => a.localeCompare(b)),
  };
}
