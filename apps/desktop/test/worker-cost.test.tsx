import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkerCost, FleetBurn } from "../src/renderer/components/WorkerCost.js";
import { useStore } from "../src/renderer/store/store.js";
import type { LogItem } from "../src/renderer/store/reduce.js";

const metrics = (cost: number): LogItem => ({ kind: "metrics", contextPct: 0, tokens: 0, turns: 1, durationMs: 0, cost });

beforeEach(() => useStore.setState({ workerLogs: {} }));

describe("WorkerCost", () => {
  it("shows the latest cumulative cost from the worker's metrics", () => {
    useStore.setState({ workerLogs: { w1: [metrics(0.01), metrics(0.42)] } });
    render(<WorkerCost workerId="w1" />);
    expect(screen.getByText("$0.42")).toBeInTheDocument();
  });

  it("renders nothing when the worker has no cost yet", () => {
    const { container } = render(<WorkerCost workerId="w2" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("FleetBurn", () => {
  it("sums the latest cost across only the given live worker ids", () => {
    useStore.setState({ workerLogs: { w1: [metrics(0.4)], w2: [metrics(0.1)], wArchived: [metrics(9.99)] } });
    render(<FleetBurn ids={["w1", "w2"]} />);
    expect(screen.getByText("$0.50")).toBeInTheDocument(); // wArchived excluded
  });

  it("renders nothing when no listed worker has cost", () => {
    const { container } = render(<FleetBurn ids={["x", "y"]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
