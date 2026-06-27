import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RepoModal } from "../src/renderer/components/RepoModal.js";

const existing = [{ name: "app", path: "/code/app" }];
const type = (ph: string, v: string) => fireEvent.change(screen.getByPlaceholderText(ph), { target: { value: v } });

describe("RepoModal duplicate validation", () => {
  it("blocks duplicate name and shows inline error", () => {
    const onRegister = vi.fn();
    render(<RepoModal repos={existing} onRegister={onRegister} onClose={() => {}} />);
    type("이름", "app");               // namePlaceholder ko fallback
    type("경로", "/code/new");         // pathPlaceholder ko fallback
    fireEvent.click(screen.getByText("등록")); // register button ko fallback
    expect(screen.getByText("이미 같은 이름의 레포가 있어요")).toBeInTheDocument();
    expect(onRegister).not.toHaveBeenCalled();
  });
  it("blocks duplicate path and shows inline error", () => {
    const onRegister = vi.fn();
    render(<RepoModal repos={existing} onRegister={onRegister} onClose={() => {}} />);
    type("이름", "newname");
    type("경로", "/code/app");
    fireEvent.click(screen.getByText("등록"));
    expect(screen.getByText("이미 같은 경로의 레포가 있어요")).toBeInTheDocument();
    expect(onRegister).not.toHaveBeenCalled();
  });
  it("registers when name and path are new (trimmed)", () => {
    const onRegister = vi.fn();
    render(<RepoModal repos={existing} onRegister={onRegister} onClose={() => {}} />);
    type("이름", " ads ");
    type("경로", " /code/ads ");
    fireEvent.click(screen.getByText("등록"));
    expect(onRegister).toHaveBeenCalledWith({ name: "ads", path: "/code/ads", description: "" });
  });
});
