import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Button } from "../src/renderer/ui/button.js";

describe("Button loading state", () => {
  it("shows a spinner, is disabled, and marks aria-busy when loading", () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Save</Button>);
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(btn.querySelector("svg")).not.toBeNull(); // spinner svg present
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled(); // disabled → no click
  });

  it("is neither disabled nor busy without loading", () => {
    render(<Button>Save</Button>);
    const btn = screen.getByRole("button");
    expect(btn).not.toBeDisabled();
    expect(btn).not.toHaveAttribute("aria-busy", "true");
    expect(btn.querySelector("svg")).toBeNull();
  });

  it("defaults to type=button (no accidental form submit)", () => {
    render(<Button>x</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
  });
});
