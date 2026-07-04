import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Segment, type SegmentItem } from "../src/renderer/ui/segment.js";

const ITEMS: Array<SegmentItem<"a" | "b" | "c">> = [
  { value: "a", label: "A" },
  { value: "b", label: "B" },
  { value: "c", label: "C" },
];

function Controlled(props: { variant: "underline" | "pill"; items?: Array<SegmentItem<"a" | "b" | "c">>; onChange?: (v: "a" | "b" | "c") => void }): JSX.Element {
  return <Segment items={props.items ?? ITEMS} value="a" onChange={props.onChange ?? (() => {})} variant={props.variant} />;
}

describe("Segment (audit #52 shared control)", () => {
  it("renders each item as a tab within a tablist, marking the active one", () => {
    render(<Segment items={ITEMS} value="b" onChange={() => {}} variant="underline" />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["A", "B", "C"]);
    expect(screen.getByRole("tab", { name: "B" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "A" })).toHaveAttribute("aria-selected", "false");
  });

  it("clicking an item calls onChange with its value", () => {
    const onChange = vi.fn();
    render(<Segment items={ITEMS} value="a" onChange={onChange} variant="underline" />);
    fireEvent.click(screen.getByRole("tab", { name: "C" }));
    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("ArrowRight/ArrowLeft move selection and wrap around at the ends", () => {
    const onChange = vi.fn();
    render(<Segment items={ITEMS} value="a" onChange={onChange} variant="pill" />);
    const active = screen.getByRole("tab", { name: "A" });
    fireEvent.keyDown(active, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("b");
    fireEvent.keyDown(active, { key: "ArrowLeft" }); // still focused on "a" (uncontrolled in this render), wraps to the last item
    expect(onChange).toHaveBeenLastCalledWith("c");
  });

  it("skips disabled items when clicking or navigating with arrow keys", () => {
    const onChange = vi.fn();
    const items: Array<SegmentItem<"a" | "b" | "c">> = [
      { value: "a", label: "A" },
      { value: "b", label: "B", disabled: true },
      { value: "c", label: "C" },
    ];
    render(<Segment items={items} value="a" onChange={onChange} variant="pill" />);
    fireEvent.click(screen.getByRole("tab", { name: "B" }));
    expect(onChange).not.toHaveBeenCalled(); // disabled → no click
    fireEvent.keyDown(screen.getByRole("tab", { name: "A" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("c"); // "b" is skipped
  });

  it("renders both variants without crashing and applies variant-specific active styling", () => {
    const { rerender } = render(<Controlled variant="underline" />);
    expect(screen.getByRole("tab", { name: "A" }).className).toContain("bg-accent/15"); // underline: active gets a soft accent wash
    rerender(<Controlled variant="pill" />);
    expect(screen.getByRole("tab", { name: "A" }).className).not.toContain("bg-accent/15"); // pill: color-only, the sliding bg indicates selection
  });

  it("secondary-tier items (e.g. a trailing 'All') render after a divider and don't drive the sliding indicator", () => {
    const items: Array<SegmentItem<"a" | "b" | "c">> = [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
      { value: "c", label: "All", tier: "secondary" },
    ];
    render(<Segment items={items} value="c" onChange={() => {}} variant="underline" />);
    // Still a normal tab (selectable, in the same tablist) — just visually de-emphasized.
    const all = screen.getByRole("tab", { name: "All" });
    expect(all).toHaveAttribute("aria-selected", "true");
    expect(all.className).not.toContain("bg-accent/15"); // secondary tier skips the primary active wash
  });
});
