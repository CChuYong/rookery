import { createHash } from "node:crypto";
import path from "node:path";
import type {
  McpServerSpec,
  ResolvedAgentCapabilities,
  SecretRef,
} from "../capabilities/types.js";

export interface CodexSecretBinding {
  envName: string;
  packInstanceId: string;
  ref: SecretRef;
}

interface CodexMcpCommonConfig {
  enabled: true;
  required?: true;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
  enabledTools?: string[];
  disabledTools?: string[];
}

export interface CodexStdioMcpConfig extends CodexMcpCommonConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  envVars?: string[];
  cwd?: string;
}

export interface CodexHttpMcpConfig extends CodexMcpCommonConfig {
  transport: "streamable-http";
  url: string;
  bearerTokenEnvVar?: string;
  httpHeaders?: Record<string, string>;
  envHttpHeaders?: Record<string, string>;
}

export type CodexMcpConfig = CodexStdioMcpConfig | CodexHttpMcpConfig;

export interface CodexStdioLauncherPlan {
  generatedName: string;
  launcherPath: string;
  descriptorPath: string;
  descriptor: {
    command: string;
    args: string[];
    cwd: string;
    secretEnv: Record<string, string>;
  };
}

export interface CodexCapabilityPlan {
  revision: string;
  instructions: Array<{ id: string; label: string; path: string }>;
  skills: Array<{ id: string; path: string }>;
  mcpServers: Array<{ generatedName: string; config: CodexMcpConfig }>;
  stdioLaunchers: CodexStdioLauncherPlan[];
  secretBindings: CodexSecretBinding[];
  diagnostics: string[];
}

function secretIdentity(ref: SecretRef): string {
  return ref.source === "rookery-secret" ? `rookery-secret:${ref.key}` : `environment:${ref.name}`;
}

export function codexSecretEnvName(packInstanceId: string, ref: SecretRef): string {
  const digest = createHash("sha256")
    .update(packInstanceId)
    .update("\0")
    .update(secretIdentity(ref))
    .digest("hex")
    .slice(0, 24)
    .toUpperCase();
  return `ROOKERY_CAP_SECRET_${digest}`;
}

function addSecretBinding(
  bindings: Map<string, CodexSecretBinding>,
  packInstanceId: string,
  ref: SecretRef,
): string {
  const envName = codexSecretEnvName(packInstanceId, ref);
  bindings.set(envName, { envName, packInstanceId, ref });
  return envName;
}

function commonConfig(spec: McpServerSpec): CodexMcpCommonConfig {
  return {
    enabled: true,
    ...(spec.required ? { required: true as const } : {}),
    ...(spec.startupTimeoutSec !== undefined ? { startupTimeoutSec: spec.startupTimeoutSec } : {}),
    ...(spec.toolTimeoutSec !== undefined ? { toolTimeoutSec: spec.toolTimeoutSec } : {}),
    ...(spec.enabledTools?.length ? { enabledTools: [...spec.enabledTools] } : {}),
    ...(spec.disabledTools?.length ? { disabledTools: [...spec.disabledTools] } : {}),
  };
}

function launcherFileName(generatedName: string): string {
  return `${Buffer.from(generatedName).toString("hex")}.json`;
}

export function compileCodexCapabilities(
  capabilities: ResolvedAgentCapabilities,
  sourceRootFor: (packInstanceId: string) => string,
  codexRoot: string,
): CodexCapabilityPlan {
  if (capabilities.blocked) {
    throw new Error(`capability runtime ${capabilities.revision} is blocked`);
  }

  const generatedNames = new Set<string>();
  for (const server of capabilities.mcpServers) {
    if (server.generatedName === "rookery") {
      throw new Error("Codex MCP server id rookery is reserved for the Rookery daemon bridge");
    }
    if (generatedNames.has(server.generatedName)) {
      throw new Error(`duplicate Codex MCP server id: ${server.generatedName}`);
    }
    generatedNames.add(server.generatedName);
  }

  const bindings = new Map<string, CodexSecretBinding>();
  const stdioLaunchers: CodexStdioLauncherPlan[] = [];
  const runtimeDir = path.join(codexRoot, "mcp-runtime");
  const launcherPath = path.join(runtimeDir, "stdio-launcher.mjs");
  const mcpServers = [...capabilities.mcpServers]
    .sort((a, b) => a.generatedName.localeCompare(b.generatedName))
    .map((server): { generatedName: string; config: CodexMcpConfig } => {
      const spec = server.spec;
      const common = commonConfig(spec);
      if (spec.transport === "stdio") {
        const sourceRoot = sourceRootFor(server.packInstanceId);
        const cwd = spec.cwd ? path.join(sourceRoot, spec.cwd) : sourceRoot;
        const secretEnv = Object.fromEntries(Object.entries(spec.secretEnv ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, ref]) => [name, addSecretBinding(bindings, server.packInstanceId, ref)]));

        if (Object.keys(secretEnv).length === 0) {
          return {
            generatedName: server.generatedName,
            config: {
              transport: "stdio",
              command: spec.command,
              ...(spec.args?.length ? { args: [...spec.args] } : {}),
              ...(spec.cwd ? { cwd } : {}),
              ...(spec.env && Object.keys(spec.env).length > 0 ? { env: { ...spec.env } } : {}),
              ...common,
            },
          };
        }

        const descriptorPath = path.join(runtimeDir, launcherFileName(server.generatedName));
        stdioLaunchers.push({
          generatedName: server.generatedName,
          launcherPath,
          descriptorPath,
          descriptor: {
            command: spec.command,
            args: [...(spec.args ?? [])],
            cwd,
            secretEnv,
          },
        });
        return {
          generatedName: server.generatedName,
          config: {
            transport: "stdio",
            command: process.execPath,
            args: [launcherPath, descriptorPath],
            ...(spec.env && Object.keys(spec.env).length > 0 ? { env: { ...spec.env } } : {}),
            envVars: Object.values(secretEnv).sort((a, b) => a.localeCompare(b)),
            ...common,
          },
        };
      }

      const envHttpHeaders = Object.fromEntries(Object.entries(spec.secretHeaders ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, ref]) => [name, addSecretBinding(bindings, server.packInstanceId, ref)]));
      const bearerTokenEnvVar = spec.auth
        ? addSecretBinding(bindings, server.packInstanceId, spec.auth.bearerToken)
        : undefined;
      return {
        generatedName: server.generatedName,
        config: {
          transport: "streamable-http",
          url: spec.url,
          ...(spec.headers && Object.keys(spec.headers).length > 0 ? { httpHeaders: { ...spec.headers } } : {}),
          ...(Object.keys(envHttpHeaders).length > 0 ? { envHttpHeaders } : {}),
          ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}),
          ...common,
        },
      };
    });

  return {
    revision: capabilities.revision,
    instructions: [...capabilities.instructions]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((instruction) => ({
        id: instruction.id,
        label: `${instruction.packId}/${instruction.id}`,
        path: path.join(sourceRootFor(instruction.packInstanceId), instruction.path),
      })),
    skills: [...capabilities.skills]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((skill) => ({
        id: skill.id,
        path: path.join(sourceRootFor(skill.packInstanceId), skill.path, "SKILL.md"),
      })),
    mcpServers,
    stdioLaunchers,
    secretBindings: [...bindings.values()].sort((a, b) => a.envName.localeCompare(b.envName)),
    diagnostics: [],
  };
}
