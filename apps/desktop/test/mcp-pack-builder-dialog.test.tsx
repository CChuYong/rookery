import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CapabilityMcpPackCreateResult } from "@daemon/core/capabilities/types.js";
import { McpPackBuilderDialog } from "../src/renderer/components/capabilities/McpPackBuilderDialog.js";

const result = {
  pack: { instanceId: "pack-1", status: "untrusted" },
  binding: { id: "binding-1", scopeKind: "repo-local", scopeRef: "repo-1" },
} as unknown as CapabilityMcpPackCreateResult;

describe("McpPackBuilderDialog", () => {
  it("builds multiple HTTP/stdio servers and submits write-only values", async () => {
    let resolve!: (value: CapabilityMcpPackCreateResult) => void;
    const create = vi.fn(() => new Promise<CapabilityMcpPackCreateResult>((done) => { resolve = done; }));
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<McpPackBuilderDialog
      repos={[{ id: "repo-1", label: "Rookery" }, { id: "repo-2", label: "API" }]}
      create={create}
      onCreated={onCreated}
      onClose={onClose}
    />);

    fireEvent.change(screen.getByLabelText("Pack 이름"), { target: { value: "Repo Tools" } });
    expect(screen.getByLabelText("Pack ID")).toHaveValue("repo-tools");
    fireEvent.change(screen.getByLabelText("대상 레포"), { target: { value: "repo-1" } });

    const first = screen.getByTestId("mcp-server-0");
    fireEvent.change(within(first).getByLabelText("서버 ID"), { target: { value: "docs" } });
    fireEvent.change(within(first).getByLabelText("HTTP URL"), { target: { value: "https://example.test/mcp" } });
    fireEvent.change(within(first).getByLabelText("Bearer secret key"), { target: { value: "docs-token" } });
    fireEvent.change(within(first).getByLabelText("Bearer secret 값"), { target: { value: "docs-secret" } });
    expect(within(first).getByLabelText("Bearer secret 값")).toHaveAttribute("type", "password");

    fireEvent.click(screen.getByRole("button", { name: "MCP 서버 추가" }));
    const second = screen.getByTestId("mcp-server-1");
    fireEvent.change(within(second).getByLabelText("전송 방식"), { target: { value: "stdio" } });
    fireEvent.change(within(second).getByLabelText("서버 ID"), { target: { value: "db" } });
    fireEvent.change(within(second).getByLabelText("명령어"), { target: { value: "npx" } });
    fireEvent.change(within(second).getByLabelText("인자 (한 줄에 하나)"), { target: { value: "-y\ndb-mcp" } });
    fireEvent.click(within(second).getByRole("button", { name: "Secret 항목 추가" }));
    fireEvent.change(within(second).getByLabelText("대상 이름"), { target: { value: "TOKEN" } });
    fireEvent.change(within(second).getByLabelText("Secret key"), { target: { value: "db-token" } });
    fireEvent.change(within(second).getByLabelText("Secret 값"), { target: { value: "db-secret" } });
    expect(within(second).getByLabelText("Secret 값")).toHaveAttribute("type", "password");

    fireEvent.click(screen.getByRole("button", { name: "Pack 만들기" }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      id: "repo-tools",
      repoId: "repo-1",
      agents: ["master", "worker"],
      mcpServers: [
        expect.objectContaining({ id: "docs", transport: "streamable-http", url: "https://example.test/mcp" }),
        expect.objectContaining({ id: "db", transport: "stdio", command: "npx", args: ["-y", "db-mcp"] }),
      ],
      secretValues: { "docs-token": "docs-secret", "db-token": "db-secret" },
    }));
    expect(screen.getByRole("button", { name: "Pack 만들기" })).toBeDisabled();
    expect(document.body.textContent).not.toContain("docs-secret");
    expect(document.body.textContent).not.toContain("db-secret");

    resolve(result);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(result));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("shows localized validation, preserves the draft after rejection and Escape, and closes from Cancel", async () => {
    const create = vi.fn().mockRejectedValue(new Error("daemon unavailable"));
    const onClose = vi.fn();
    render(<McpPackBuilderDialog
      repos={[{ id: "repo-1", label: "Rookery" }]}
      create={create}
      onCreated={vi.fn()}
      onClose={onClose}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Pack 만들기" }));
    expect(screen.getByText("Pack 이름을 입력하세요.")).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Pack 이름"), { target: { value: "Docs" } });
    fireEvent.change(screen.getByLabelText("대상 레포"), { target: { value: "repo-1" } });
    const server = screen.getByTestId("mcp-server-0");
    fireEvent.change(within(server).getByLabelText("서버 ID"), { target: { value: "docs" } });
    fireEvent.change(within(server).getByLabelText("HTTP URL"), { target: { value: "https://example.test/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "Pack 만들기" }));
    expect(await screen.findByText("daemon unavailable")).toBeInTheDocument();
    expect(screen.getByLabelText("Pack 이름")).toHaveValue("Docs");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Pack 이름")).toHaveValue("Docs");

    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("can remove a second server but always keeps at least one", () => {
    render(<McpPackBuilderDialog
      repos={[{ id: "repo-1", label: "Rookery" }]}
      create={vi.fn()}
      onCreated={vi.fn()}
      onClose={vi.fn()}
    />);
    expect(screen.getAllByTestId(/mcp-server-/)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "서버 제거" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "MCP 서버 추가" }));
    expect(screen.getAllByTestId(/mcp-server-/)).toHaveLength(2);
    fireEvent.click(within(screen.getByTestId("mcp-server-1")).getByRole("button", { name: "서버 제거" }));
    expect(screen.getAllByTestId(/mcp-server-/)).toHaveLength(1);
  });
});
