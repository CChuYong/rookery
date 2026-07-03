import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
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
