import type {
  CapabilityBinding,
  CapabilityBindingInput,
  CapabilityLibraryEntry,
  CapabilityLibrarySnapshot,
  CapabilitySecretStatus,
  CapabilitySnapshot,
  CapabilityTarget,
} from "@daemon/core/capabilities/types.js";

export interface CapabilityCenterApi {
  loadSnapshot(target: CapabilityTarget): Promise<CapabilitySnapshot>;
  loadLibrary(): Promise<CapabilityLibrarySnapshot>;
  addPack(sourcePath: string): Promise<CapabilityLibraryEntry>;
  removePack(instanceId: string): Promise<void>;
  setTrust(instanceId: string, digest: string, trusted: boolean): Promise<CapabilityLibraryEntry>;
  setSecret(instanceId: string, key: string, value: string): Promise<CapabilitySecretStatus>;
  deleteSecret(instanceId: string, key: string): Promise<CapabilitySecretStatus>;
  refresh(instanceId?: string): Promise<CapabilityLibrarySnapshot>;
  setBinding(id: string, input: CapabilityBindingInput): Promise<CapabilityBinding>;
  deleteBinding(id: string): Promise<void>;
}

export interface CapabilityTargetOptions {
  repos: Array<{ id: string; label: string }>;
  sessions: Array<{ id: string; label: string }>;
  workers: Array<{ id: string; label: string }>;
}
