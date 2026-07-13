import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  CapabilityPackFile,
  CapabilityPackManifest,
  McpServerSpec,
  SecretRef,
} from "./types.js";

export const MAX_CAPABILITY_PACK_FILES = 2_000;
export const MAX_CAPABILITY_PACK_BYTES = 64 * 1024 * 1024;

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SECRET_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CREDENTIAL_KEY_PATTERN = /(^|[_-])(authorization|token|key|secret|password|cookie)([_-]|$)/i;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const idSchema = z.string().trim().regex(ID_PATTERN, "must match /^[a-z0-9][a-z0-9._-]{0,63}$/");

function isPortableRelativePath(value: string): boolean {
  if (!value || value.includes("\0") || value.includes("\\")) return false;
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  return !value.split("/").some((part) => part === "..");
}

const relativePathSchema = z.string().trim().min(1)
  .refine(isPortableRelativePath, "must be a portable relative path inside the pack root")
  .transform((value) => value.replace(/^\.\/+/, ""));

const secretRefSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("rookery-secret"),
    key: z.string().trim().regex(SECRET_KEY_PATTERN, "must be a valid secret key"),
  }).strict(),
  z.object({
    source: z.literal("environment"),
    name: z.string().trim().regex(ENV_NAME_PATTERN, "must be a valid environment variable name"),
  }).strict(),
]);

const stringMapSchema = z.record(z.string().min(1), z.string());
const secretMapSchema = z.record(z.string().min(1), secretRefSchema);
const toolListSchema = z.array(z.string().trim().min(1)).max(1_000)
  .transform((values) => [...new Set(values)].sort(compareText));

const mcpCommonShape = {
  id: idSchema,
  enabledTools: toolListSchema.optional(),
  disabledTools: toolListSchema.optional(),
  required: z.boolean().optional(),
  startupTimeoutSec: z.number().int().min(1).max(120).optional(),
  toolTimeoutSec: z.number().int().min(1).max(600).optional(),
};

const stdioMcpSchema = z.object({
  ...mcpCommonShape,
  transport: z.literal("stdio"),
  command: z.string().trim().min(1).max(4_096),
  args: z.array(z.string().max(16_384)).max(1_000).optional(),
  cwd: relativePathSchema.optional(),
  env: stringMapSchema.optional(),
  secretEnv: secretMapSchema.optional(),
}).strict();

const httpMcpSchema = z.object({
  ...mcpCommonShape,
  transport: z.literal("streamable-http"),
  url: z.string().trim().min(1).max(8_192).refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an HTTP or HTTPS URL"),
  headers: stringMapSchema.optional(),
  secretHeaders: secretMapSchema.optional(),
  auth: z.object({ bearerToken: secretRefSchema }).strict().optional(),
}).strict();

const capabilityPackSchema = z.object({
  schemaVersion: z.literal(1),
  id: idSchema,
  displayName: z.string().trim().min(1).max(80),
  version: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500),
  instructions: z.array(z.object({ id: idSchema, path: relativePathSchema }).strict()).max(1_000).optional(),
  skills: z.array(z.object({ id: idSchema, path: relativePathSchema }).strict()).max(1_000).optional(),
  mcpServers: z.array(z.discriminatedUnion("transport", [stdioMcpSchema, httpMcpSchema])).max(1_000).optional(),
}).strict();

export interface ValidatedCapabilityPack {
  root: string;
  manifest: CapabilityPackManifest;
  digest: string;
  files: CapabilityPackFile[];
}

export interface CapabilitySecretRequirement {
  source: "rookery-secret" | "environment";
  key: string;
}

export class CapabilityPackValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid capability pack:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "CapabilityPackValidationError";
  }
}

function throwValidation(...issues: string[]): never {
  throw new CapabilityPackValidationError(issues);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => compareText(a, b))
      .map(([key, nested]) => [key, stableValue(nested)]));
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function normalizedMcpId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function validateUniqueIds(kind: string, values: Array<{ id: string }> | undefined): void {
  const seen = new Set<string>();
  for (const value of values ?? []) {
    if (seen.has(value.id)) throwValidation(`duplicate ${kind} id: ${value.id}`);
    seen.add(value.id);
  }
}

function validateMcpIds(servers: McpServerSpec[] | undefined): void {
  validateUniqueIds("MCP server", servers);
  const normalized = new Map<string, string>();
  for (const server of servers ?? []) {
    const safe = normalizedMcpId(server.id);
    const previous = normalized.get(safe);
    if (previous) {
      throwValidation(`provider-normalized MCP id collision: ${previous} and ${server.id} both normalize to ${safe}`);
    }
    normalized.set(safe, server.id);
  }
}

function validatePublicCredentialKeys(servers: McpServerSpec[] | undefined): void {
  for (const server of servers ?? []) {
    if (server.transport === "stdio") {
      for (const key of Object.keys(server.env ?? {})) {
        if (CREDENTIAL_KEY_PATTERN.test(key)) {
          throwValidation(`MCP ${server.id} env key ${key} looks credential-bearing; use secretEnv`);
        }
      }
    } else {
      for (const key of Object.keys(server.headers ?? {})) {
        if (CREDENTIAL_KEY_PATTERN.test(key)) {
          throwValidation(`MCP ${server.id} header ${key} looks credential-bearing; use secretHeaders or auth`);
        }
      }
    }
  }
}

function normalizeManifest(manifest: CapabilityPackManifest): CapabilityPackManifest {
  return {
    ...manifest,
    ...(manifest.instructions ? { instructions: [...manifest.instructions].sort((a, b) => compareText(a.id, b.id)) } : {}),
    ...(manifest.skills ? { skills: [...manifest.skills].sort((a, b) => compareText(a.id, b.id)) } : {}),
    ...(manifest.mcpServers ? { mcpServers: [...manifest.mcpServers].sort((a, b) => compareText(a.id, b.id)) } : {}),
  };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realpathForWalk(root: string, logicalPath: string, relativePath: string): string {
  try {
    const real = fs.realpathSync.native(logicalPath);
    if (!isInside(root, real)) throwValidation(`symlink at ${relativePath || "."} resolves outside the pack root`);
    return real;
  } catch (error) {
    if (error instanceof CapabilityPackValidationError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throwValidation(`symlink cycle at ${relativePath || "."}`);
    throwValidation(`cannot resolve ${relativePath || "."}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface WalkedFile {
  info: CapabilityPackFile;
  bytes: Buffer;
}

function walkPack(root: string, limits: { maxFiles: number; maxBytes: number }): WalkedFile[] {
  const files: WalkedFile[] = [];
  let totalBytes = 0;

  const visit = (logicalPath: string, relativePath: string, ancestorDirectories: Set<string>): void => {
    const real = realpathForWalk(root, logicalPath, relativePath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(logicalPath);
    } catch (error) {
      throwValidation(`cannot inspect ${relativePath || "."}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (stat.isDirectory()) {
      if (ancestorDirectories.has(real)) throwValidation(`symlink cycle at ${relativePath || "."}`);
      const nextAncestors = new Set(ancestorDirectories);
      nextAncestors.add(real);
      const names = fs.readdirSync(logicalPath).sort(compareText);
      for (const name of names) {
        const childRelative = relativePath ? `${relativePath}/${name}` : name;
        visit(path.join(logicalPath, name), childRelative, nextAncestors);
      }
      return;
    }

    if (!stat.isFile()) throwValidation(`unsupported file type at ${relativePath}`);
    if (files.length >= limits.maxFiles) throwValidation(`pack contains more than ${limits.maxFiles} files`);
    const bytes = fs.readFileSync(logicalPath);
    totalBytes += bytes.length;
    if (totalBytes > limits.maxBytes) throwValidation(`pack contains more than ${limits.maxBytes} bytes`);
    const mode = stat.mode & 0o777;
    files.push({
      info: {
        path: relativePath.split(path.sep).join("/"),
        mode,
        size: bytes.length,
        executable: (mode & 0o111) !== 0,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      bytes,
    });
  };

  visit(root, "", new Set());
  return files.sort((a, b) => compareText(a.info.path, b.info.path));
}

function resolveRequiredPath(root: string, relativePath: string, label: string, kind: "file" | "directory"): string {
  const logicalPath = path.resolve(root, relativePath);
  if (!isInside(root, logicalPath)) throwValidation(`${label} must resolve inside the pack root: ${relativePath}`);
  let real: string;
  try {
    real = fs.realpathSync.native(logicalPath);
  } catch {
    throwValidation(`${label} does not exist: ${relativePath}`);
  }
  if (!isInside(root, real)) throwValidation(`${label} resolves outside the pack root: ${relativePath}`);
  const stat = fs.statSync(logicalPath);
  if (kind === "file" && !stat.isFile()) throwValidation(`${label} must be a file: ${relativePath}`);
  if (kind === "directory" && !stat.isDirectory()) throwValidation(`${label} must be a directory: ${relativePath}`);
  return logicalPath;
}

function scalarValue(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === "string" ? parsed : "";
    } catch {
      return "";
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

function parseSkillFrontmatter(skillFile: string, label: string): { name: string; description: string } {
  const content = fs.readFileSync(skillFile, "utf8").replace(/\r\n?/g, "\n");
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") throwValidation(`${label} SKILL.md must start with frontmatter`);
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) throwValidation(`${label} SKILL.md has unterminated frontmatter`);

  const values = new Map<string, string>();
  for (let index = 1; index < end; index++) {
    const line = lines[index]!;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const raw = match[2]!;
    if (raw === ">" || raw === "|") {
      const chunks: string[] = [];
      while (index + 1 < end && /^\s+/.test(lines[index + 1]!)) {
        index++;
        chunks.push(lines[index]!.trim());
      }
      values.set(key, raw === ">" ? chunks.join(" ").trim() : chunks.join("\n").trim());
    } else {
      values.set(key, scalarValue(raw));
    }
  }

  const name = values.get("name")?.trim() ?? "";
  const description = values.get("description")?.trim() ?? "";
  if (!name) throwValidation(`${label} SKILL.md frontmatter requires a non-empty name`);
  if (!description) throwValidation(`${label} SKILL.md frontmatter requires a non-empty description`);
  return { name, description };
}

function validateReferencedPaths(root: string, manifest: CapabilityPackManifest): void {
  for (const instruction of manifest.instructions ?? []) {
    resolveRequiredPath(root, instruction.path, `instruction ${instruction.id}`, "file");
  }
  for (const skill of manifest.skills ?? []) {
    const skillRoot = resolveRequiredPath(root, skill.path, `skill ${skill.id}`, "directory");
    const skillFile = resolveRequiredPath(root, path.join(skill.path, "SKILL.md"), `skill ${skill.id} SKILL.md`, "file");
    const frontmatter = parseSkillFrontmatter(skillFile, `skill ${skill.id}`);
    if (frontmatter.name !== skill.id) {
      throwValidation(`skill ${skill.id} id must equal SKILL.md name ${frontmatter.name}`);
    }
    if (!isInside(root, fs.realpathSync.native(skillRoot))) {
      throwValidation(`skill ${skill.id} resolves outside the pack root`);
    }
  }
  for (const server of manifest.mcpServers ?? []) {
    if (server.transport === "stdio" && server.cwd) {
      resolveRequiredPath(root, server.cwd, `MCP ${server.id} cwd`, "directory");
    }
  }
}

function digestPack(manifest: CapabilityPackManifest, files: WalkedFile[]): string {
  const hash = createHash("sha256");
  const add = (value: string | Buffer): void => {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    hash.update(String(bytes.length));
    hash.update(":");
    hash.update(bytes);
    hash.update("\0");
  };
  add(stableStringify(manifest));
  for (const file of files) {
    add(file.info.path);
    add(String(file.info.mode));
    add(file.bytes);
  }
  return hash.digest("hex");
}

function zodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.length ? issue.path.join(".") : "manifest"}: ${issue.message}`);
}

export function validateCapabilityPack(
  inputRoot: string,
  limits: { maxFiles: number; maxBytes: number } = {
    maxFiles: MAX_CAPABILITY_PACK_FILES,
    maxBytes: MAX_CAPABILITY_PACK_BYTES,
  },
): ValidatedCapabilityPack {
  if (!Number.isInteger(limits.maxFiles) || limits.maxFiles < 1) throw new Error("maxFiles must be a positive integer");
  if (!Number.isInteger(limits.maxBytes) || limits.maxBytes < 1) throw new Error("maxBytes must be a positive integer");

  let root: string;
  try {
    root = fs.realpathSync.native(inputRoot);
  } catch {
    throwValidation(`pack root does not exist: ${inputRoot}`);
  }
  if (!fs.statSync(root).isDirectory()) throwValidation(`pack root must be a directory: ${inputRoot}`);

  const manifestPath = path.join(root, "capability.json");
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throwValidation(`cannot read capability.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = capabilityPackSchema.safeParse(raw);
  if (!parsed.success) throw new CapabilityPackValidationError(zodIssues(parsed.error));
  const manifest = normalizeManifest(parsed.data as CapabilityPackManifest);

  validateUniqueIds("instruction", manifest.instructions);
  validateUniqueIds("skill", manifest.skills);
  validateMcpIds(manifest.mcpServers);
  validatePublicCredentialKeys(manifest.mcpServers);

  const walked = walkPack(root, limits);
  validateReferencedPaths(root, manifest);
  return {
    root,
    manifest,
    digest: digestPack(manifest, walked),
    files: walked.map((file) => file.info),
  };
}

function secretRequirement(ref: SecretRef): CapabilitySecretRequirement {
  return ref.source === "rookery-secret"
    ? { source: ref.source, key: ref.key }
    : { source: ref.source, key: ref.name };
}

export function collectSecretRequirements(manifest: CapabilityPackManifest): CapabilitySecretRequirement[] {
  const byIdentity = new Map<string, CapabilitySecretRequirement>();
  const add = (ref: SecretRef): void => {
    const requirement = secretRequirement(ref);
    byIdentity.set(`${requirement.source}:${requirement.key}`, requirement);
  };
  for (const server of manifest.mcpServers ?? []) {
    if (server.transport === "stdio") {
      for (const ref of Object.values(server.secretEnv ?? {})) add(ref);
    } else {
      for (const ref of Object.values(server.secretHeaders ?? {})) add(ref);
      if (server.auth) add(server.auth.bearerToken);
    }
  }
  return [...byIdentity.values()].sort((a, b) => compareText(a.source, b.source) || compareText(a.key, b.key));
}
