import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkerCost } from "../src/renderer/components/WorkerCost.js";
import { useStore } from "../src/renderer/store/store.js";
import type { LogItem } from "../src/renderer/store/reduce.js";

const metrics = (cost: number): Extract<LogItem, { kind: "metrics" }> => ({ kind: "metrics", contextPct: 0, tokens: 0, turns: 1, durationMs: 0, cost });

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

it("an unavailable worker cost never looks like a reliable zero", () => {
  useStore.setState({ workerLogs: { w1: [{ ...metrics(0), costAccuracy: "unavailable" }] } });
  render(<WorkerCost workerId="w1" />);
  expect(screen.queryByText("$0.00")).toBeNull();
  expect(screen.getAllByLabelText(/집계가 불완전/)).toHaveLength(1);
});
it("Codex snapshot costs remain explicitly estimated without loading history", () => {
  useStore.setState({ fleet: { w1: { id: "w1", provider: "codex", costAccuracy: "estimated" } as import("../src/renderer/store/reduce.js").FleetRow } });
  render(<WorkerCost workerId="w1" fleetCost={2.5} />);
  expect(screen.getByText(/추정.*\$2.50/)).toBeInTheDocument();
});

it("estimated compact costs retain the exact amount in the tooltip", () => {
  useStore.setState({ fleet: { w1: { id: "w1", provider: "codex", costAccuracy: "estimated" } as import("../src/renderer/store/reduce.js").FleetRow } });
  render(<WorkerCost workerId="w1" fleetCost={15800} compact />);
  expect(screen.getByText(/추정.*15.8k/)).toHaveAttribute("title", expect.stringContaining("15,800"));
});
