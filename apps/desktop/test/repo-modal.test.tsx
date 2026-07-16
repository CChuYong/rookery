import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RepoModal } from "../src/renderer/components/RepoModal.js";

const existing = [{ name: "app", path: "/code/app" }];
const type = (ph: string, v: string) => fireEvent.change(screen.getByPlaceholderText(ph), { target: { value: v } });

describe("RepoModal duplicate validation", () => {
  it("preserves entered repository data on Escape and closes from Cancel", async () => {
    const onClose = vi.fn();
    render(<RepoModal repos={existing} onRegister={vi.fn()} onClose={onClose} />);
    type("my-service", "draft-repo");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("my-service")).toHaveValue("draft-repo");

    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("blocks duplicate name and shows inline error", () => {
    const onRegister = vi.fn();
    render(<RepoModal repos={existing} onRegister={onRegister} onClose={() => {}} />);
    type("my-service", "app");               // namePlaceholder ko fallback
    type("/Users/you/project", "/code/new"); // pathPlaceholder ko fallback
    fireEvent.click(screen.getByText("등록")); // register button ko fallback
    expect(screen.getByText("이미 같은 이름의 레포가 있어요")).toBeInTheDocument();
    expect(onRegister).not.toHaveBeenCalled();
  });
  it("blocks duplicate path and shows inline error", () => {
    const onRegister = vi.fn();
    render(<RepoModal repos={existing} onRegister={onRegister} onClose={() => {}} />);
    type("my-service", "newname");
    type("/Users/you/project", "/code/app");
    fireEvent.click(screen.getByText("등록"));
    expect(screen.getByText("이미 같은 경로의 레포가 있어요")).toBeInTheDocument();
    expect(onRegister).not.toHaveBeenCalled();
  });
  it("registers when name and path are new (trimmed)", () => {
    const onRegister = vi.fn();
    render(<RepoModal repos={existing} onRegister={onRegister} onClose={() => {}} />);
    type("my-service", " ads ");
    type("/Users/you/project", " /code/ads ");
    fireEvent.click(screen.getByText("등록"));
    expect(onRegister).toHaveBeenCalledWith({ name: "ads", path: "/code/ads", description: "" });
  });
});
