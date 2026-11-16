import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { Tooltip } from "../src/renderer/components/Tooltip.js";

describe("Tooltip", () => {
  it("bubble sizes to content (w-max) up to a cap, not to the trigger width (audit #37)", () => {
    const { getByRole } = render(
      <Tooltip label="설정">
        <button>gear</button>
      </Tooltip>,
    );
    const bubble = getByRole("tooltip", { hidden: true });
    expect(bubble.className).toContain("w-max");
    expect(bubble.className).toContain("max-w-[220px]");
  });
});

// audit #132: a clicked button kept focus, so focus-within left the bubble hanging over the page it opened.
describe("Tooltip visibility (audit #132)", () => {
  it("shows on hover or keyboard focus only, and Escape hides it", () => {
    const { getByRole } = render(
      <Tooltip label="설정">
        <button>gear</button>
      </Tooltip>,
    );
    const bubble = getByRole("tooltip", { hidden: true });
    expect(bubble.className).toContain("group-has-[:focus-visible]/tip:opacity-100");
    expect(bubble.className).not.toContain("group-focus-within:opacity-100");
    fireEvent.keyDown(getByRole("button", { name: "gear" }), { key: "Escape" });
    expect(bubble.className).toContain("invisible");
  });
});
