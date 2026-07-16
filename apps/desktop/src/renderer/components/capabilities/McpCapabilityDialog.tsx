import type { CapabilityCatalogCreateResult, CapabilityMcpCreateInput } from "@daemon/core/capabilities/types.js";
import { McpPackBuilderDialog } from "./McpPackBuilderDialog.js";

export interface McpCapabilityDialogProps {
  create(input: CapabilityMcpCreateInput): Promise<CapabilityCatalogCreateResult>;
  onCreated(result: CapabilityCatalogCreateResult): void;
  onClose(): void;
}

export function McpCapabilityDialog(props: McpCapabilityDialogProps): JSX.Element {
  return <McpPackBuilderDialog mode="capability" {...props} />;
}
