// The provider cost watermark persisted inside the last master.result / worker result payload (undefined when absent/corrupt).
export function providerCostTotalOf(payloadJson: string | undefined | null): number | undefined {
  if (!payloadJson) return undefined;
  try {
    const v = (JSON.parse(payloadJson) as { providerCostTotalUsd?: unknown }).providerCostTotalUsd;
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  } catch { return undefined; }
}
