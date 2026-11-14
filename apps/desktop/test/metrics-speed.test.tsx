import { expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MetricsView } from "../src/renderer/components/MetricsView.js";

it("renders an accessible unknown marker for incomplete metrics", () => {
  render(<MetricsView items={[{ kind: "metrics", cost: 0, costAccuracy: "unavailable", tokens: 0, turns: 1, durationMs: 0, contextPct: 0 }]} />);
  expect(screen.queryByText("$0.00")).toBeNull();
  expect(screen.getByLabelText(/집계가 불완전/)).toHaveTextContent("—");
});
it("labels estimated metrics", () => {
  render(<MetricsView items={[{ kind: "metrics", cost: 1.2, costAccuracy: "estimated", tokens: 0, turns: 1, durationMs: 0, contextPct: 0 }]} />);
  expect(screen.getByText(/추정.*\$1.20/)).toBeInTheDocument();
});
