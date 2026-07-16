import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Repositories, CapabilityPackRow } from "../../persistence/repositories.js";
import {
  CapabilityPackValidationError,
  collectSecretRequirements,
  validateCapabilityPack,
} from "./manifest.js";
import { loadRepoSharedIndex, resolveRepoSharedPackPath } from "./repo-shared.js";
import type {
  CapabilityBinding,
  CapabilityBindingInput,
  CapabilityDiagnostic,
  CapabilityLibraryEntry,
  CapabilityLibrarySnapshot,
  CapabilityPackChange,
  CapabilityPackFile,
  CapabilityPackManifest,
  CapabilityPackSourceKind,
  CapabilityQuickBindingInput,
  CapabilityScopeRef,
  CapabilitySecretStatus,
} from "./types.js";

type ValidationStatus = "valid" | "invalid" | "source-missing";

interface CapabilityRegistryDocument {
  manifest: CapabilityPackManifest;
  files: CapabilityPackFile[];
  changes: CapabilityPackChange[];
  validationStatus: ValidationStatus;
  errors: string[];
}

export interface CapabilityRegistryChange {
  generation: number;
  affected: CapabilityScopeRef[];
}

export interface CapabilityRegistryOptions {
  id?: () => string;
  onChanged?: (change: CapabilityRegistryChange) => void;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseDocument(row: CapabilityPackRow): CapabilityRegistryDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.manifest_json);
  } catch {
    throw new Error(`capability pack ${row.instance_id} has corrupt registry metadata`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`capability pack ${row.instance_id} has invalid registry metadata`);
  }
  const document = parsed as Partial<CapabilityRegistryDocument>;
  if (!document.manifest || !Array.isArray(document.files)) {
    throw new Error(`capability pack ${row.instance_id} has incomplete registry metadata`);
  }
  return {
    manifest: document.manifest,
    files: document.files,
    changes: Array.isArray(document.changes) ? document.changes : [],
    validationStatus: document.validationStatus ?? "valid",
    errors: Array.isArray(document.errors) ? document.errors : [],
  };
}

function serializeDocument(document: CapabilityRegistryDocument): string {
  return JSON.stringify(document);
}

function changesBetween(previous: CapabilityPackFile[], next: CapabilityPackFile[]): CapabilityPackChange[] {
  const oldFiles = new Map(previous.map((file) => [file.path, file]));
  const newFiles = new Map(next.map((file) => [file.path, file]));
  const changes: CapabilityPackChange[] = [];
  for (const [filePath, file] of newFiles) {
    const old = oldFiles.get(filePath);
    if (!old) changes.push({ path: filePath, kind: "added" });
    else if (old.sha256 !== file.sha256 || old.mode !== file.mode || old.size !== file.size) {
      changes.push({ path: filePath, kind: "modified" });
    }
  }
  for (const filePath of oldFiles.keys()) {
    if (!newFiles.has(filePath)) changes.push({ path: filePath, kind: "removed" });
  }
  return changes.sort((a, b) => compareText(a.path, b.path) || compareText(a.kind, b.kind));
}

function uniqueScopes(scopes: CapabilityScopeRef[]): CapabilityScopeRef[] {
  const values = new Map(scopes.map((scope) => [`${scope.scopeKind}\0${scope.scopeRef}`, scope]));
  return [...values.values()].sort((a, b) =>
    compareText(a.scopeKind, b.scopeKind) || compareText(a.scopeRef, b.scopeRef));
}

function validationErrors(error: unknown): string[] {
  if (error instanceof CapabilityPackValidationError) return error.issues;
  return [error instanceof Error ? error.message : String(error)];
}

export class CapabilityRegistry {
  private generation = 0;
  private readonly repoDiagnostics = new Map<string, CapabilityDiagnostic[]>();
  private readonly createId: () => string;
  private readonly onChanged?: (change: CapabilityRegistryChange) => void;

  constructor(
    private readonly repos: Repositories,
    options: CapabilityRegistryOptions = {},
  ) {
    this.createId = options.id ?? randomUUID;
    this.onChanged = options.onChanged;
  }

  private emit(affected: CapabilityScopeRef[]): void {
    this.generation++;
    this.onChanged?.({ generation: this.generation, affected: uniqueScopes(affected) });
  }

  private affectedForPack(instanceId: string): CapabilityScopeRef[] {
    return this.repos.listCapabilityBindings(instanceId).map((binding) => ({
      scopeKind: binding.scopeKind,
      scopeRef: binding.scopeRef,
    }));
  }

  private secretStatuses(instanceId: string, manifest: CapabilityPackManifest): CapabilitySecretStatus[] {
    const configured = new Set(this.repos.listCapabilitySecretMetadata(instanceId).map((secret) => secret.key));
    return collectSecretRequirements(manifest)
      .filter((requirement) => requirement.source === "rookery-secret")
      .map((requirement) => ({ key: requirement.key, configured: configured.has(requirement.key) }));
  }

  private entryFromRow(row: CapabilityPackRow): CapabilityLibraryEntry {
    const document = parseDocument(row);
    const status = document.validationStatus === "valid"
      ? (this.repos.isCapabilityDigestTrusted(row.instance_id, row.digest) ? "trusted" : "untrusted")
      : document.validationStatus;
    return {
      instanceId: row.instance_id,
      sourceKind: row.source_kind,
      sourcePath: row.source_path,
      ownerRepoId: row.owner_repo_id,
      manifest: document.manifest,
      digest: row.digest,
      status,
      errors: [...document.errors],
      files: [...document.files],
      changes: [...document.changes],
      secrets: this.secretStatuses(row.instance_id, document.manifest),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  add(
    sourcePath: string,
    options: { sourceKind?: CapabilityPackSourceKind; ownerRepoId?: string | null } = {},
  ): CapabilityLibraryEntry {
    const sourceKind = options.sourceKind ?? "local-directory";
    const validated = validateCapabilityPack(sourcePath);
    if (this.repos.listCapabilityPacks().some((pack) => pack.source_path === validated.root)) {
      throw new Error(`capability pack source is already registered: ${validated.root}`);
    }
    if (sourceKind === "repo-shared") {
      if (!options.ownerRepoId || !this.repos.listRepos().some((repo) => repo.id === options.ownerRepoId)) {
        throw new Error(`repo-shared capability pack requires a registered owner repo`);
      }
    } else if (options.ownerRepoId) {
      throw new Error(`${sourceKind} capability packs cannot have an owner repo`);
    }
    const instanceId = this.createId();
    const document: CapabilityRegistryDocument = {
      manifest: validated.manifest,
      files: validated.files,
      changes: [],
      validationStatus: "valid",
      errors: [],
    };
    const row = this.repos.createCapabilityPack({
      instanceId,
      logicalId: validated.manifest.id,
      sourceKind,
      ownerRepoId: options.ownerRepoId ?? null,
      sourcePath: validated.root,
      manifestJson: serializeDocument(document),
      digest: validated.digest,
    });
    this.emit([]);
    return this.entryFromRow(row);
  }

  remove(instanceId: string): void {
    if (!this.repos.getCapabilityPack(instanceId)) throw new Error(`unknown capability pack: ${instanceId}`);
    const affected = this.affectedForPack(instanceId);
    this.repos.deleteCapabilityPack(instanceId);
    this.emit(affected);
  }

  get(instanceId: string): CapabilityLibraryEntry | undefined {
    const row = this.repos.getCapabilityPack(instanceId);
    return row ? this.entryFromRow(row) : undefined;
  }

  list(): CapabilityLibrarySnapshot {
    return {
      generation: this.generation,
      packs: this.repos.listCapabilityPacks().map((row) => this.entryFromRow(row)),
      bindings: this.repos.listCapabilityBindings(),
      diagnostics: [...this.repoDiagnostics.values()].flat().sort((a, b) =>
        compareText(a.source, b.source) || compareText(a.id, b.id)),
    };
  }

  private updateRowFromSource(row: CapabilityPackRow): CapabilityScopeRef[] {
    const previous = parseDocument(row);
    let document: CapabilityRegistryDocument;
    let logicalId = row.logical_id;
    let digest = row.digest;
    try {
      const validated = validateCapabilityPack(row.source_path);
      document = {
        manifest: validated.manifest,
        files: validated.files,
        changes: changesBetween(previous.files, validated.files),
        validationStatus: "valid",
        errors: [],
      };
      logicalId = validated.manifest.id;
      digest = validated.digest;
    } catch (error) {
      document = {
        ...previous,
        validationStatus: fs.existsSync(row.source_path) ? "invalid" : "source-missing",
        errors: validationErrors(error),
      };
    }
    this.repos.updateCapabilityPack(row.instance_id, {
      logicalId,
      manifestJson: serializeDocument(document),
      digest,
    });
    return this.affectedForPack(row.instance_id);
  }

  private markRepoRowsInvalid(repoId: string, message: string): CapabilityScopeRef[] {
    const affected: CapabilityScopeRef[] = [];
    for (const row of this.repos.listCapabilityPacks().filter((pack) => pack.source_kind === "repo-shared" && pack.owner_repo_id === repoId)) {
      const previous = parseDocument(row);
      this.repos.updateCapabilityPack(row.instance_id, {
        logicalId: row.logical_id,
        manifestJson: serializeDocument({ ...previous, validationStatus: "invalid", errors: [message] }),
        digest: row.digest,
      });
      affected.push(...this.affectedForPack(row.instance_id));
    }
    return affected;
  }

  reconcileRepoShared(repoId?: string): CapabilityLibrarySnapshot {
    const selected = this.repos.listRepos().filter((repo) => repoId === undefined || repo.id === repoId);
    if (repoId !== undefined && selected.length === 0) throw new Error(`unknown repo capability owner: ${repoId}`);
    const affected: CapabilityScopeRef[] = [];
    let changed = false;

    for (const repo of selected) {
      const source = `repo:${repo.name}/.rookery/capabilities.json`;
      const index = loadRepoSharedIndex(repo.path);
      const owned = this.repos.listCapabilityPacks().filter((pack) => pack.source_kind === "repo-shared" && pack.owner_repo_id === repo.id);
      const diagnostics: CapabilityDiagnostic[] = [];

      if (index.status === "invalid") {
        const message = `Invalid repo-shared capability index: ${index.error}`;
        affected.push(...this.markRepoRowsInvalid(repo.id, message));
        diagnostics.push({ id: `repo-shared:${repo.id}:index`, source, severity: "error", message });
        if (owned.length > 0 || JSON.stringify(this.repoDiagnostics.get(repo.id) ?? []) !== JSON.stringify(diagnostics)) changed = true;
        this.repoDiagnostics.set(repo.id, diagnostics);
        continue;
      }

      if (index.status === "missing") {
        for (const row of owned) {
          affected.push(...this.affectedForPack(row.instance_id));
          this.repos.deleteCapabilityPack(row.instance_id);
          changed = true;
        }
        if (this.repoDiagnostics.has(repo.id)) changed = true;
        this.repoDiagnostics.delete(repo.id);
        continue;
      }

      const retained = new Set<string>();
      for (const [position, entry] of index.entries.entries()) {
        let sourcePath: string;
        try {
          sourcePath = resolveRepoSharedPackPath(repo.path, entry.path);
        } catch (error) {
          diagnostics.push({
            id: `repo-shared:${repo.id}:${position}`,
            source: `${source}#${entry.path}`,
            severity: "error",
            message: validationErrors(error)[0]!,
          });
          continue;
        }
        const existing = owned.find((row) => path.resolve(row.source_path) === path.resolve(sourcePath));
        if (entry.disabled) {
          if (existing) {
            affected.push(...this.affectedForPack(existing.instance_id));
            this.repos.deleteCapabilityPack(existing.instance_id);
            changed = true;
          }
          continue;
        }
        if (existing && retained.has(existing.instance_id)) {
          diagnostics.push({
            id: `repo-shared:${repo.id}:${position}`,
            source: `${source}#${entry.path}`,
            severity: "error",
            message: `Duplicate repo-shared capability path: ${entry.path}`,
          });
          continue;
        }
        try {
          if (existing) {
            retained.add(existing.instance_id);
            affected.push(...this.updateRowFromSource(existing));
            changed = true;
          } else {
            const validated = validateCapabilityPack(sourcePath);
            const instanceId = this.createId();
            this.repos.createCapabilityPack({
              instanceId,
              logicalId: validated.manifest.id,
              sourceKind: "repo-shared",
              ownerRepoId: repo.id,
              sourcePath: validated.root,
              manifestJson: serializeDocument({
                manifest: validated.manifest,
                files: validated.files,
                changes: [],
                validationStatus: "valid",
                errors: [],
              }),
              digest: validated.digest,
            });
            retained.add(instanceId);
            changed = true;
          }
        } catch (error) {
          const errors = validationErrors(error);
          if (existing) {
            retained.add(existing.instance_id);
            const previous = parseDocument(existing);
            this.repos.updateCapabilityPack(existing.instance_id, {
              logicalId: existing.logical_id,
              manifestJson: serializeDocument({ ...previous, validationStatus: fs.existsSync(sourcePath) ? "invalid" : "source-missing", errors }),
              digest: existing.digest,
            });
            affected.push(...this.affectedForPack(existing.instance_id));
            changed = true;
          }
          diagnostics.push({
            id: `repo-shared:${repo.id}:${position}`,
            source: `${source}#${entry.path}`,
            severity: "error",
            message: errors[0]!,
          });
        }
      }

      for (const row of owned) {
        if (retained.has(row.instance_id) || !this.repos.getCapabilityPack(row.instance_id)) continue;
        affected.push(...this.affectedForPack(row.instance_id));
        this.repos.deleteCapabilityPack(row.instance_id);
        changed = true;
      }
      if (JSON.stringify(this.repoDiagnostics.get(repo.id) ?? []) !== JSON.stringify(diagnostics)) changed = true;
      if (diagnostics.length > 0) this.repoDiagnostics.set(repo.id, diagnostics);
      else this.repoDiagnostics.delete(repo.id);
    }

    if (changed) this.emit(affected);
    return this.list();
  }

  invalidate(affected: CapabilityScopeRef[], repoId?: string): void {
    if (repoId) this.repoDiagnostics.delete(repoId);
    this.emit(affected);
  }

  refresh(instanceId?: string): CapabilityLibrarySnapshot {
    if (instanceId === undefined) {
      const affected: CapabilityScopeRef[] = [];
      const localRows = this.repos.listCapabilityPacks().filter((pack) => pack.source_kind !== "repo-shared");
      for (const row of localRows) {
        affected.push(...this.updateRowFromSource(row));
      }
      if (localRows.length > 0) this.emit(affected);
      return this.reconcileRepoShared();
    }
    const rows = instanceId === undefined
      ? this.repos.listCapabilityPacks()
      : [this.repos.getCapabilityPack(instanceId)].filter((row): row is CapabilityPackRow => row !== undefined);
    if (instanceId !== undefined && rows.length === 0) throw new Error(`unknown capability pack: ${instanceId}`);

    if (rows[0]?.source_kind === "repo-shared") return this.reconcileRepoShared(rows[0].owner_repo_id!);

    const affected: CapabilityScopeRef[] = [];
    for (const row of rows) {
      affected.push(...this.updateRowFromSource(row));
    }
    this.emit(affected);
    return this.list();
  }

  setTrust(instanceId: string, digest: string, trusted: boolean): CapabilityLibraryEntry {
    const row = this.repos.getCapabilityPack(instanceId);
    if (!row) throw new Error(`unknown capability pack: ${instanceId}`);
    if (row.digest !== digest) throw new Error(`trust digest must equal the current digest for ${instanceId}`);
    const document = parseDocument(row);
    if (document.validationStatus !== "valid" && trusted) {
      throw new Error(`cannot trust ${document.validationStatus} capability pack: ${instanceId}`);
    }
    this.repos.setCapabilityTrust(instanceId, digest, trusted);
    if (trusted && document.changes.length > 0) {
      this.repos.updateCapabilityPack(instanceId, {
        logicalId: row.logical_id,
        manifestJson: serializeDocument({ ...document, changes: [] }),
        digest: row.digest,
      });
    }
    this.emit(this.affectedForPack(instanceId));
    return this.get(instanceId)!;
  }

  private assertDeclaredSecret(instanceId: string, key: string): void {
    const pack = this.get(instanceId);
    if (!pack) throw new Error(`unknown capability pack: ${instanceId}`);
    const declared = collectSecretRequirements(pack.manifest)
      .some((requirement) => requirement.source === "rookery-secret" && requirement.key === key);
    if (!declared) throw new Error(`Rookery secret ${key} is not declared by capability pack ${instanceId}`);
  }

  setSecret(instanceId: string, key: string, value: string): CapabilitySecretStatus {
    this.assertDeclaredSecret(instanceId, key);
    if (!value.trim()) throw new Error(`capability secret value must not be empty`);
    this.repos.setCapabilitySecret(instanceId, key, value);
    this.emit(this.affectedForPack(instanceId));
    return { key, configured: true };
  }

  deleteSecret(instanceId: string, key: string): CapabilitySecretStatus {
    this.assertDeclaredSecret(instanceId, key);
    this.repos.deleteCapabilitySecret(instanceId, key);
    this.emit(this.affectedForPack(instanceId));
    return { key, configured: false };
  }

  getSecretVersions(instanceId: string): ReadonlyMap<string, number> {
    return new Map(this.repos.listCapabilitySecretMetadata(instanceId)
      .map((secret) => [secret.key, secret.version]));
  }

  // Daemon/runtime boundary only. Callers must never place this value in a protocol projection,
  // event, generated file, command line, diagnostic, or log.
  getSecretValueForRuntime(instanceId: string, key: string): string | undefined {
    this.assertDeclaredSecret(instanceId, key);
    return this.repos.getCapabilitySecretValue(instanceId, key);
  }

  private assertScopeAuthority(input: CapabilityBindingInput): void {
    if (!this.repos.getCapabilityPack(input.packInstanceId)) {
      throw new Error(`unknown capability pack: ${input.packInstanceId}`);
    }
    if (input.scopeKind === "rookery") {
      if (input.scopeRef !== "") throw new Error(`rookery capability scope ref must be empty`);
      return;
    }
    if (!input.scopeRef) throw new Error(`${input.scopeKind} capability scope ref must not be empty`);
    if (input.scopeKind === "repo-local" || input.scopeKind === "repo-shared") {
      const repo = this.repos.listRepos().find((candidate) => candidate.id === input.scopeRef);
      if (!repo) throw new Error(`unknown repo capability scope: ${input.scopeRef}`);
      if (input.scopeKind === "repo-shared") {
        const pack = this.repos.getCapabilityPack(input.packInstanceId)!;
        if (pack.source_kind !== "repo-shared" || pack.owner_repo_id !== repo.id) {
          throw new Error(`repo-shared scope requires a repo-shared pack owned by ${repo.id}`);
        }
      }
      return;
    }
    if (input.scopeKind === "session" && !this.repos.getSession(input.scopeRef)) {
      throw new Error(`unknown session capability scope: ${input.scopeRef}`);
    }
    if (input.scopeKind === "worker" && !this.repos.getWorker(input.scopeRef)) {
      throw new Error(`unknown worker capability scope: ${input.scopeRef}`);
    }
  }

  setBinding(id: string, input: CapabilityBindingInput): CapabilityBinding {
    this.assertScopeAuthority(input);
    const previous = this.repos.getCapabilityBinding(id);
    const binding = this.repos.setCapabilityBinding(id, input);
    this.emit([
      ...(previous ? [{ scopeKind: previous.scopeKind, scopeRef: previous.scopeRef }] : []),
      { scopeKind: binding.scopeKind, scopeRef: binding.scopeRef },
    ]);
    return binding;
  }

  quickSetBinding(input: CapabilityQuickBindingInput): CapabilityBinding | null {
    this.assertScopeAuthority({
      packInstanceId: input.packInstanceId,
      scopeKind: input.scopeKind,
      scopeRef: input.scopeRef,
      audience: { agents: input.agents.length > 0 ? input.agents : ["master"], origins: ["ui"] },
      enabled: input.mode === "enabled",
    });
    const binding = this.repos.replaceCapabilityUiBinding(this.createId(), input);
    this.emit([{ scopeKind: input.scopeKind, scopeRef: input.scopeRef }]);
    return binding;
  }

  deleteBinding(id: string): void {
    const binding = this.repos.getCapabilityBinding(id);
    if (!binding) throw new Error(`unknown capability binding: ${id}`);
    this.repos.deleteCapabilityBinding(id);
    this.emit([{ scopeKind: binding.scopeKind, scopeRef: binding.scopeRef }]);
  }
}
