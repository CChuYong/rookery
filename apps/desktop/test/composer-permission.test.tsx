import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Composer } from "../src/renderer/components/Composer.js";

describe("Composer permission-mode selector", () => {
  it("renders the 4 modes and calls onPermissionMode on change (editable master)", () => {
    const onPermissionMode = vi.fn();
    render(
      <Composer
        onSend={() => {}}
        controls={{ model: "claude-opus-4-8", effort: "high", permissionMode: "bypassPermissions", editable: true, onPermissionMode }}
      />,
    );
    const sel = screen.getByTitle(/권한 모드|Permission mode/) as HTMLSelectElement;
    expect(sel).toBeInTheDocument();
    expect(sel.value).toBe("bypassPermissions");
    // The 4 mode labels (Claude official names)
    ["Bypass Permissions", "Default", "Plan Mode", "Accept Edits"].forEach((l) => expect(screen.getByText(l)).toBeInTheDocument());
    fireEvent.change(sel, { target: { value: "default" } });
    expect(onPermissionMode).toHaveBeenCalledWith("default");
  });

  it("hides the selector when permissionMode is undefined (e.g. read-only badge)", () => {
    render(<Composer onSend={() => {}} controls={{ model: "claude-opus-4-8", editable: true }} />);
    expect(screen.queryByTitle(/권한 모드|Permission mode/)).toBeNull();
  });

  it("restricts to the given modes for a worker (bypass+plan only) and fires onPermissionMode", () => {
    const onPermissionMode = vi.fn();
    render(
      <Composer
        onSend={() => {}}
        controls={{ model: "claude-opus-4-8", permissionMode: "bypassPermissions", permissionModes: ["bypassPermissions", "plan"], editable: true, onPermissionMode }}
      />,
    );
    const sel = screen.getByTitle(/권한 모드|Permission mode/) as HTMLSelectElement;
    expect(sel.value).toBe("bypassPermissions");
    expect(screen.getByText("Bypass Permissions")).toBeInTheDocument();
    expect(screen.getByText("Plan Mode")).toBeInTheDocument();
    // restricted: the master-only modes are NOT offered to a worker
    expect(screen.queryByText("Default")).toBeNull();
    expect(screen.queryByText("Accept Edits")).toBeNull();
    fireEvent.change(sel, { target: { value: "plan" } });
    expect(onPermissionMode).toHaveBeenCalledWith("plan");
  });
});
