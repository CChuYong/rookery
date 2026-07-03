import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MonacoEditor } from "../src/renderer/components/MonacoEditor.js";
// vitest.config.ts aliases the "monaco-editor" bare specifier (used by MonacoEditor.tsx/monacoLang.ts) to this fake —
// import it via the relative path so tsc still checks this file against the real package's types elsewhere.
import { __instances as instances } from "./mocks/monaco-editor.js";

const latestEditor = () => instances[instances.length - 1]!;

const SAVE_ERROR = "저장하지 못했어요 — 편집 내용이 디스크에 반영되지 않았어요";
const SAVE_RETRY = "다시 저장";
const OPEN_ERROR = "이 파일을 열 수 없어요 — 현재 작업 폴더 밖이거나 읽기에 실패했어요.";

function mockWs(over: Record<string, unknown> = {}) {
  (window as unknown as { rookery: unknown }).rookery = {
    ws: {
      read: vi.fn(async () => ({ content: "hello", tooLarge: false })),
      write: vi.fn(async () => ({ ok: true })),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
      ...over,
    },
  };
}

beforeEach(() => { instances.length = 0; });

describe("MonacoEditor save-failure feedback (#10)", () => {
  it("shows the saveError banner (not openError) when a Cmd+S write rejects, and retry re-saves", async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce({ ok: true });
    mockWs({ write });
    render(<MonacoEditor pageKey="p1" path="/r/a.ts" />);
    await waitFor(() => expect(latestEditor().getValue()).toBe("hello"));

    act(() => { latestEditor().commandCb?.(); }); // simulate Cmd+S
    expect(await screen.findByText(SAVE_ERROR)).toBeInTheDocument();
    expect(screen.queryByText(OPEN_ERROR)).toBeNull();

    fireEvent.click(screen.getByText(SAVE_RETRY));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(SAVE_ERROR)).toBeNull());
  });

  it("shows the saveError banner when the write promise resolves { ok: false }", async () => {
    mockWs({ write: vi.fn(async () => ({ ok: false })) });
    render(<MonacoEditor pageKey="p1" path="/r/a.ts" />);
    await waitFor(() => expect(latestEditor().getValue()).toBe("hello"));
    act(() => { latestEditor().commandCb?.(); });
    expect(await screen.findByText(SAVE_ERROR)).toBeInTheDocument();
  });

  it("leaves the read-failure openError path untouched", async () => {
    mockWs({ read: vi.fn(async () => { throw new Error("denied"); }) });
    render(<MonacoEditor pageKey="p1" path="/r/a.ts" />);
    expect(await screen.findByText(OPEN_ERROR)).toBeInTheDocument();
    expect(screen.queryByText(SAVE_ERROR)).toBeNull();
  });
});
