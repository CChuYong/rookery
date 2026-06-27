// The effort level the SDK accepts. (Haiku doesn't support effort → filtered out by effortApplies.)
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

const LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

// Narrow an arbitrary string to a valid EffortLevel (invalid → undefined → omitted from the options).
export function coerceEffort(v: string | undefined): EffortLevel | undefined {
  return v && (LEVELS as readonly string[]).includes(v) ? (v as EffortLevel) : undefined;
}

// The effort parameter is not supported on Haiku (API 400). Pass it only to the others (Opus/Sonnet/Fable).
export function effortApplies(model: string): boolean {
  return !/haiku/i.test(model);
}
