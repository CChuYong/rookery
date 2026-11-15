import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MonacoEditor } from "../src/renderer/components/MonacoEditor.js";
// vitest.config.ts aliases the "monaco-editor" bare specifier (used by MonacoEditor.tsx/monacoLang.ts) to this fake —
// import it via the relative path so tsc still checks this file against the real package's types elsewhere.
import { __instances as instances } from "./mocks/monaco-editor.js";

const latestEditor = () => instances[instances.length - 1]!;

const SAVE_ERROR = "저장하지 못했어요 — 편집 내용이 디스크에 반영되지 않았어요";
const SAVE_RETRY = "다시 저장";
const OPEN_ERROR = "이 파일을 열 수 없어요 — 읽기에 실패했어요.";
const READ_ONLY = "읽기 전용 — 작업 폴더 밖 파일이라 여기서는 저장할 수 없어요.";

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

  it("opens a file outside the work folder read-only: banner shown, editor locked, Cmd+S does nothing", async () => {
    const write = vi.fn(async () => ({ ok: true }));
    mockWs({ read: vi.fn(async () => ({ content: "outside", tooLarge: false, readOnly: true })), write });
    render(<MonacoEditor pageKey="p1" path="/tmp/write-test.txt" />);
    expect(await screen.findByText(READ_ONLY)).toBeInTheDocument();
    expect(latestEditor().getValue()).toBe("outside");
    expect(latestEditor().readOnly).toBe(true);
    act(() => { latestEditor().commandCb?.(); });
    expect(write).not.toHaveBeenCalled();
    expect(screen.queryByText(OPEN_ERROR)).toBeNull();
  });

  it("files inside the work folder stay editable with no read-only banner", async () => {
    mockWs();
    render(<MonacoEditor pageKey="p1" path="/r/a.ts" />);
    await waitFor(() => expect(latestEditor().getValue()).toBe("hello"));
    expect(latestEditor().readOnly).toBe(false);
    expect(screen.queryByText(READ_ONLY)).toBeNull();
  });
});

// audit #17: until a file has actually loaded (or when it can't be), the empty buffer must not be editable or
// savable — Cmd+S there would overwrite the real file with a few typed characters.
describe("MonacoEditor locks the buffer until the file has loaded (audit #17)", () => {
  it("is read-only and won't save while the first read is still in flight", async () => {
    let finish!: (v: { content: string; tooLarge: boolean }) => void;
    const write = vi.fn(async () => ({ ok: true }));
    mockWs({ read: vi.fn(() => new Promise((r) => { finish = r; })), write });
    render(<MonacoEditor pageKey="p1" path="/r/a.ts" />);
    expect(latestEditor().readOnly).toBe(true);
    act(() => { latestEditor().commandCb?.(); });
    expect(write).not.toHaveBeenCalled();
    await act(async () => finish({ content: "hello", tooLarge: false }));
    expect(latestEditor().readOnly).toBe(false);
  });

  it("stays read-only and won't save after a read failure", async () => {
    const write = vi.fn(async () => ({ ok: true }));
    mockWs({ read: vi.fn(async () => { throw new Error("nope"); }), write });
    render(<MonacoEditor pageKey="p1" path="/r/a.ts" />);
    expect(await screen.findByText(OPEN_ERROR)).toBeInTheDocument();
    expect(latestEditor().readOnly).toBe(true);
    act(() => { latestEditor().commandCb?.(); });
    expect(write).not.toHaveBeenCalled();
  });

  it("stays read-only and won't save a file too large to open", async () => {
    const write = vi.fn(async () => ({ ok: true }));
    mockWs({ read: vi.fn(async () => ({ content: "", tooLarge: true })), write });
    render(<MonacoEditor pageKey="p1" path="/r/a.ts" />);
    await screen.findByText("미리보기 불가 — 바이너리이거나 너무 큰 파일이에요.");
    expect(latestEditor().readOnly).toBe(true);
    act(() => { latestEditor().commandCb?.(); });
    expect(write).not.toHaveBeenCalled();
  });
});

// Review fix 7: a failed first read must not leave the editor locked for good — a later successful file-watch read
// loads the file and unlocks it.
describe("MonacoEditor recovers after a failed first read (review fix 7)", () => {
  it("a file-watch read that succeeds loads the content, clears the banner and unlocks saving", async () => {
    let changed: (p: string) => void = () => {};
    const write = vi.fn(async () => ({ ok: true }));
    const read = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue({ content: "later", tooLarge: false });
    mockWs({ read, write, onChanged: vi.fn((cb: (p: string) => void) => { changed = cb; return () => {}; }) });
    render(<MonacoEditor pageKey="p1" path="/r/a.ts" />);
    expect(await screen.findByText(OPEN_ERROR)).toBeInTheDocument();
    await act(async () => { changed("/r/a.ts"); await Promise.resolve(); await Promise.resolve(); });
    await waitFor(() => expect(latestEditor().getValue()).toBe("later"));
    expect(latestEditor().readOnly).toBe(false);
    await waitFor(() => expect(screen.queryByText(OPEN_ERROR)).toBeNull());
    act(() => { latestEditor().commandCb?.(); });
    expect(write).toHaveBeenCalledWith("/r/a.ts", "later");
  });
});
