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

  it("prefers the live log cost over a lower fleet costUsd (max — a streaming worker stays fresh)", () => {
    useStore.setState({ workerLogs: { w1: [metrics(5)] } });
    render(<WorkerCost workerId="w1" fleetCost={2.5} />);
    expect(screen.getByText("$5.00")).toBeInTheDocument();
  });
});

describe("FleetBurn", () => {
  it("sums the latest cost across only the given live worker rows", () => {
    useStore.setState({ workerLogs: { w1: [metrics(0.4)], w2: [metrics(0.1)], wArchived: [metrics(9.99)] } });
    render(<FleetBurn rows={[{ id: "w1" }, { id: "w2" }]} />);
    expect(screen.getByText("$0.50")).toBeInTheDocument(); // wArchived excluded
  });

  it("renders nothing when no listed worker has cost", () => {
    const { container } = render(<FleetBurn rows={[{ id: "x" }, { id: "y" }]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("prefers the fleet-provided costUsd over the log when higher (no log loaded)", () => {
    render(<FleetBurn rows={[{ id: "w1", costUsd: 2.5 }, { id: "w2", costUsd: 1.25 }]} />);
    expect(screen.getByText("$3.75")).toBeInTheDocument();
  });
});
