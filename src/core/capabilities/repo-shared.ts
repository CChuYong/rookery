import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const MAX_REPO_SHARED_PACKS = 256;

const repoSharedIndexSchema = z.object({
  schemaVersion: z.literal(1),
  packs: z.array(z.object({
    path: z.string().trim().min(1),
    disabled: z.boolean().optional(),
  }).strict()).max(MAX_REPO_SHARED_PACKS),
}).strict();

export interface RepoSharedIndexEntry {
  path: string;
  disabled: boolean;
}

export type RepoSharedIndexResult =
  | { status: "missing"; indexPath: string; entries: [] }
  | { status: "invalid"; indexPath: string; entries: []; error: string }
  | { status: "valid"; indexPath: string; entries: RepoSharedIndexEntry[] };

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function loadRepoSharedIndex(repoPath: string): RepoSharedIndexResult {
  const indexPath = path.join(repoPath, ".rookery", "capabilities.json");
  if (!fs.existsSync(indexPath)) return { status: "missing", indexPath, entries: [] };
  try {
    const parsed = repoSharedIndexSchema.parse(JSON.parse(fs.readFileSync(indexPath, "utf8")));
    return {
      status: "valid",
      indexPath,
      entries: parsed.packs.map((entry) => ({ path: entry.path, disabled: entry.disabled ?? false })),
    };
  } catch (error) {
    return { status: "invalid", indexPath, entries: [], error: safeError(error) };
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function resolveRepoSharedPackPath(repoPath: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error("repo-shared capability path must be relative");
  const capabilityRoot = path.resolve(repoPath, ".rookery", "capabilities");
  const candidate = path.resolve(capabilityRoot, relativePath);
  if (!isInside(capabilityRoot, candidate)) throw new Error("repo-shared capability path must stay inside .rookery/capabilities");

  if (!fs.existsSync(candidate)) return candidate;
  const canonicalCandidate = fs.realpathSync.native(candidate);
  const canonicalRoot = fs.existsSync(capabilityRoot) ? fs.realpathSync.native(capabilityRoot) : capabilityRoot;
  if (!isInside(canonicalRoot, canonicalCandidate)) throw new Error("repo-shared capability path escapes .rookery/capabilities through a symlink");
  return canonicalCandidate;
}
