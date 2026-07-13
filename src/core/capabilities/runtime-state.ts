import type { EventBus } from "../events.js";

export type CapabilityRuntimeStatus =
  | "current"
  | "pending-next-turn"
  | "pending-reload"
  | "blocked"
  | "error";

export interface CapabilityRuntimeTarget {
  targetKind: "master" | "worker";
  targetId: string;
  sessionId: string;
}

export interface CapabilityRuntimeView {
  desiredRevision: string;
  appliedRevision: string | null;
  state: CapabilityRuntimeStatus;
  error?: string;
}

interface RuntimeRecord {
  desiredRevision: string;
  appliedRevision: string | null;
  blocked: boolean;
  error?: string;
  emitted?: string;
}

function keyOf(target: CapabilityRuntimeTarget): string {
  return `${target.targetKind}:${target.targetId}`;
}

function statusOf(
  targetKind: CapabilityRuntimeTarget["targetKind"],
  desiredRevision: string,
  appliedRevision: string | null,
  blocked: boolean,
  error: string | undefined,
): CapabilityRuntimeStatus {
  if (blocked) return "blocked";
  if (error) return "error";
  if (appliedRevision === desiredRevision) return "current";
  return targetKind === "master" ? "pending-next-turn" : "pending-reload";
}

export class CapabilityRuntimeState {
  private readonly records = new Map<string, RuntimeRecord>();

  constructor(private readonly bus: EventBus) {}

  setDesired(target: CapabilityRuntimeTarget, revision: string, blocked: boolean): void {
    const previous = this.records.get(keyOf(target));
    const record: RuntimeRecord = {
      desiredRevision: revision,
      appliedRevision: previous?.appliedRevision ?? null,
      blocked,
      // Starting another application attempt for the same revision clears its previous transient error.
      ...(previous?.emitted ? { emitted: previous.emitted } : {}),
    };
    this.records.set(keyOf(target), record);
    this.emitIfChanged(target, record);
  }

  setApplied(target: CapabilityRuntimeTarget, revision: string): void {
    const previous = this.records.get(keyOf(target));
    const record: RuntimeRecord = {
      desiredRevision: previous?.desiredRevision ?? revision,
      appliedRevision: revision,
      blocked: false,
      ...(previous?.emitted ? { emitted: previous.emitted } : {}),
    };
    this.records.set(keyOf(target), record);
    this.emitIfChanged(target, record);
  }

  setError(target: CapabilityRuntimeTarget, revision: string, message: string): void {
    const previous = this.records.get(keyOf(target));
    const record: RuntimeRecord = {
      desiredRevision: revision,
      appliedRevision: previous?.appliedRevision ?? null,
      blocked: false,
      error: message,
      ...(previous?.emitted ? { emitted: previous.emitted } : {}),
    };
    this.records.set(keyOf(target), record);
    this.emitIfChanged(target, record);
  }

  inspect(target: CapabilityRuntimeTarget, desiredRevision: string, blocked: boolean): CapabilityRuntimeView {
    const record = this.records.get(keyOf(target));
    const error = record?.desiredRevision === desiredRevision ? record.error : undefined;
    const appliedRevision = record?.appliedRevision ?? null;
    return {
      desiredRevision,
      appliedRevision,
      state: statusOf(target.targetKind, desiredRevision, appliedRevision, blocked, error),
      ...(error ? { error } : {}),
    };
  }

  private emitIfChanged(target: CapabilityRuntimeTarget, record: RuntimeRecord): void {
    const state = statusOf(
      target.targetKind,
      record.desiredRevision,
      record.appliedRevision,
      record.blocked,
      record.error,
    );
    const signature = JSON.stringify([
      record.desiredRevision,
      record.appliedRevision,
      state,
    ]);
    if (record.emitted === signature) return;
    record.emitted = signature;
    this.bus.emit({
      type: "capabilities.runtime",
      sessionId: target.sessionId,
      targetKind: target.targetKind,
      targetId: target.targetId,
      desiredRevision: record.desiredRevision,
      appliedRevision: record.appliedRevision,
      state,
    });
  }
}
