import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useModalKeys } from "../src/renderer/lib/useModalKeys.js";

function ModalKeysHarness({
  escape,
  onEscape,
  onSubmit,
  child,
}: {
  escape: "close" | "ignore";
  onEscape?: () => void;
  onSubmit?: () => void;
  child?: React.ReactNode;
}): JSX.Element {
  useModalKeys(escape === "close"
    ? { escape, onEscape: onEscape!, onSubmit }
    : { escape, onSubmit });
  return <div>{child}</div>;
}

describe("useModalKeys", () => {
  it("consumes Escape without closing when the modal protects a draft", () => {
    const onEscape = vi.fn();
    render(<ModalKeysHarness escape="ignore" onEscape={onEscape} />);

    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("closes on Escape when the modal explicitly opts in", () => {
    const onEscape = vi.fn();
    render(<ModalKeysHarness escape="close" onEscape={onEscape} />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("submits on Cmd/Ctrl+Enter", () => {
    const onSubmit = vi.fn();
    render(<ModalKeysHarness escape="ignore" onSubmit={onSubmit} />);

    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });

    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("lets only the newest active modal handle a shortcut", () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    render(
      <ModalKeysHarness escape="close" onEscape={outerClose} child={
        <ModalKeysHarness escape="close" onEscape={innerClose} />
      } />,
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerClose).not.toHaveBeenCalled();
  });
});
