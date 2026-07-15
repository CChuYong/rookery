import { describe, it, expect, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  $getSelection,
  $isRangeSelection,
  getEditorPropertyFromDOMNode,
  isLexicalEditor,
} from "lexical";
import { MessageList } from "../src/renderer/components/MessageList.js";
import { StatusBadge } from "../src/renderer/components/StatusBadge.js";
import { Conversation } from "../src/renderer/views/Conversation.js";
import { NestedAgents } from "../src/renderer/views/NestedAgents.js";
import { NewSessionPage } from "../src/renderer/components/NewSessionPage.js";
import { RepoTree } from "../src/renderer/views/RepoTree.js";
import { ConversationPane } from "../src/renderer/components/ConversationPane.js";
import { MetricsView } from "../src/renderer/components/MetricsView.js";
import { useStore } from "../src/renderer/store/store.js";
import type { LogItem, FleetRow } from "../src/renderer/store/reduce.js";
import { setPromptEditorText } from "./prompt-editor-helpers.js";

describe("MessageList", () => {
  it("renders messages, plan cards, worker lines; metrics item renders no inline bubble", () => {
    const items: LogItem[] = [
      { kind: "message", role: "assistant", content: "hello" },
      { kind: "tool", toolId: "t1", name: "spawn_worker", status: "complete" },
      { kind: "worker", workerId: "a1", status: "done" },
      { kind: "metrics", contextPct: 42, tokens: 84200, turns: 3, durationMs: 12300, cost: 1.25 },
    ];
    render(<MessageList items={items} />);
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByText(/spawn_worker/)).toBeInTheDocument();
    expect(screen.getByText(/a1/)).toBeInTheDocument();
    expect(screen.queryByText("42%")).toBeNull(); // metrics is not rendered inline — the same stats are shown in the header (SessionMetrics)
  });

  it("worker line is a static span without onSelectWorker, a button with it (→ jumps to that worker)", () => {
    const items: LogItem[] = [{ kind: "worker", workerId: "a1", status: "running" }];
    const { rerender } = render(<MessageList items={items} />);
    expect(screen.queryByRole("button", { name: /a1/ })).toBeNull(); // not clickable outside the master (i.e. in a worker conversation)
    const onSelectWorker = vi.fn();
    rerender(<MessageList items={items} onSelectWorker={onSelectWorker} />);
    fireEvent.click(screen.getByRole("button", { name: /a1/ }));
    expect(onSelectWorker).toHaveBeenCalledWith("a1");
  });
});

describe("StatusBadge", () => {
  it("styles the orphaned status distinctly (not the default fallback)", () => {
    const { container } = render(<StatusBadge status="orphaned" />);
    // "유실됨" is the localized (ko fallback, no provider) full word for "orphaned" (audit #50) — no longer the raw token.
    expect(screen.getByText("유실됨")).toBeInTheDocument();
    expect(container.querySelector(".text-nochg")).toBeTruthy(); // orphaned-specific tone (not the default fallback)
  });
});

describe("NestedAgents", () => {
  it("renders one read-only panel per nested worker (label + items)", () => {
    render(
      <NestedAgents
        panels={[
          { id: "task-1", label: "explore: find X", items: [{ kind: "message", role: "assistant", content: "nested doing X" }] },
        ]}
      />,
    );
    expect(screen.getByText("🧩 explore: find X")).toBeInTheDocument();
    expect(screen.getByText("nested doing X")).toBeInTheDocument();
    expect(screen.getByText(/중첩 에이전트 · 1/)).toBeInTheDocument();
  });
});

describe("RepoTree", () => {
  const base = { activeSubId: null, onSelectSub: () => {}, onNewRepo: () => {}, onRemoveRepo: () => {} };
  const repo = { name: "app", path: "/code/app", description: "", base: null };

  it("empty repo: header-level spawn button, no empty-placeholder, spawns on click", () => {
    const onNewSub = vi.fn();
    render(<RepoTree repos={[repo]} fleet={[]} onNewSub={onNewSub} {...base} />);
    expect(screen.getByText("app")).toBeInTheDocument();
    expect(screen.queryByText("워커 없음")).toBeNull(); // no child area for an empty group
    fireEvent.click(screen.getByLabelText("워커 스폰…"));
    expect(onNewSub).toHaveBeenCalledWith("app");
  });

  it("repo with workers lists them", () => {
    const fleet: FleetRow[] = [{ id: "a1abcd", label: "Add X", repoPath: "/code/app", status: "running", branch: null, model: null, permissionMode: "bypassPermissions" }];
    render(<RepoTree repos={[repo]} fleet={fleet} onNewSub={() => {}} {...base} />);
    expect(screen.getByText("Add X")).toBeInTheDocument();
  });
});

describe("NewSessionPage", () => {
  const base = { defaultModel: "claude-opus-4-8", defaultEffort: "high", onClose: () => {} };
  const composer = (): HTMLElement => screen.getByRole("textbox", { name: "메시지 입력" });
  const type = setPromptEditorText;

  it("picks a registered repo path and starts with that cwd + default model/effort", () => {
    const onStart = vi.fn();
    render(<NewSessionPage repos={[{ name: "app", path: "/code/app" }]} onStart={onStart} {...base} />);
    fireEvent.click(screen.getByText("app")); // repo chip
    fireEvent.click(screen.getByLabelText("시작")); // composer submit = start session (empty input allowed)
    expect(onStart).toHaveBeenCalledWith({ cwd: "/code/app", prompt: undefined, model: "claude-opus-4-8", effort: "high" });
  });

  it("starts with undefined cwd/prompt when left blank (daemon default folder, empty session)", () => {
    const onStart = vi.fn();
    render(<NewSessionPage repos={[]} onStart={onStart} {...base} />);
    fireEvent.click(screen.getByLabelText("시작"));
    expect(onStart).toHaveBeenCalledWith({ cwd: undefined, prompt: undefined, model: "claude-opus-4-8", effort: "high" });
  });

  it("passes the typed prompt and submits on Enter (Escape closes)", () => {
    const onStart = vi.fn();
    const onClose = vi.fn();
    render(<NewSessionPage repos={[]} onStart={onStart} defaultModel="claude-opus-4-8" defaultEffort="high" onClose={onClose} />);
    const ed = composer();
    type(ed, "버그 고쳐줘");
    fireEvent.keyDown(ed, { key: "Enter" });
    expect(onStart).toHaveBeenCalledWith({ cwd: undefined, prompt: "버그 고쳐줘", model: "claude-opus-4-8", effort: "high" });
    fireEvent.keyDown(ed, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("labels the registered-repo chips so users understand what they are", () => {
    render(<NewSessionPage repos={[{ name: "app", path: "/code/app" }]} onStart={vi.fn()} {...base} />);
    expect(screen.getByText(/등록된 레포/)).toBeInTheDocument(); // description text above the chips (explains what the button is)
  });

  it("offers the selected repo's / skills in the composer (chat-composer parity)", async () => {
    const loadCommands = vi.fn(async (cwd?: string) => (cwd === "/code/app" ? [{ id: "review", name: "review", description: "Run a review", action: { type: "insert-prompt" as const, text: "/review" } }] : []));
    render(<NewSessionPage repos={[{ name: "app", path: "/code/app" }]} onStart={vi.fn()} loadCommands={loadCommands} {...base} />);
    fireEvent.click(screen.getByText("app")); // select cwd → load that repo's skills
    await waitFor(() => expect(loadCommands).toHaveBeenCalledWith("/code/app"));
    type(composer(), "/rev");
    await waitFor(() => expect(screen.getByText("/review")).toBeInTheDocument());
  });

  it("@ mention browses the selected repo's cwd (file-prefill parity)", async () => {
    const browseDir = vi.fn(async () => ({ dir: "/code/app", entries: [{ name: "readme.md", isDir: false, size: 1 }] }));
    render(<NewSessionPage repos={[{ name: "app", path: "/code/app" }]} onStart={vi.fn()} browseDir={browseDir} {...base} />);
    fireEvent.click(screen.getByText("app"));
    const ed = composer();
    setPromptEditorText(ed, "@");
    await waitFor(() => expect(screen.getByText("readme.md")).toBeInTheDocument());
    expect(browseDir).toHaveBeenCalledWith("", "/code/app"); // relative to the selected repo's cwd (live)
  });
});

describe("Conversation", () => {
  const composer = (): HTMLElement => screen.getByRole("textbox", { name: "메시지 입력" });
  const type = setPromptEditorText;

  it("sends input text on submit", () => {
    const onSend = vi.fn();
    render(<Conversation items={[]} onSend={onSend} />);
    type(composer(), "do it");
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    expect(onSend).toHaveBeenCalledWith("do it");
  });

  it("drag-drop: inserted as an inline chip (filename) and serialized as @{path} on send", () => {
    const onSend = vi.fn();
    const onDropFiles = vi.fn((files: File[]) => files.map((f) => `/abs/${f.name}`));
    render(<Conversation items={[]} onSend={onSend} onDropFiles={onDropFiles} />);
    const ed = composer();
    fireEvent.drop(ed, {
      dataTransfer: {
        files: [new File(["x"], "a.ts"), new File(["y"], "b.png")],
        types: ["Files"],
      },
    });
    expect(screen.getByText("a.ts")).toBeInTheDocument(); // chip = filename only
    expect(screen.getByText("b.png")).toBeInTheDocument();
    expect(screen.queryByText("/abs/a.ts")).toBeNull();
    // The editor selection remains after the inserted chips, so append ordinary text through Lexical state.
    const lexicalEditor = getEditorPropertyFromDOMNode(ed);
    if (!isLexicalEditor(lexicalEditor)) throw new Error("expected Lexical editor");
    act(() => lexicalEditor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.insertText("이거 봐줘");
    }, { discrete: true }));
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    expect(onSend).toHaveBeenCalledWith("@/abs/a.ts @/abs/b.png 이거 봐줘");
  });

  it("busy → stop stays visible; typing shows send alongside stop (abort or queue a follow-up, audit #23)", () => {
    const onStop = vi.fn();
    render(<Conversation items={[]} onSend={vi.fn()} busy onStop={onStop} />);
    // in progress + empty → stop only
    expect(screen.getByRole("button", { name: "중단" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "보내기" })).toBeNull();
    // type something → send appears, stop stays (the turn can still be aborted while typing)
    type(composer(), "follow up");
    expect(screen.getByRole("button", { name: "보내기" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "중단" })).toBeInTheDocument();
    // clear it again → send hides, stop remains
    type(composer(), "  ");
    expect(screen.queryByRole("button", { name: "보내기" })).toBeNull();
    expect(screen.getByRole("button", { name: "중단" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "중단" }));
    expect(onStop).toHaveBeenCalled();
  });

  it("ignores Enter while IME composing, submits on a clean Enter (prevents duplicate Korean sends)", () => {
    const onSend = vi.fn();
    render(<Conversation items={[]} onSend={onSend} />);
    const ed = composer();
    type(ed, "하이");
    fireEvent.keyDown(ed, { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(ed, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("하이");
  });

  it("Shift+Enter does not send (multiline)", () => {
    const onSend = vi.fn();
    render(<Conversation items={[]} onSend={onSend} />);
    const ed = composer();
    type(ed, "line1");
    fireEvent.keyDown(ed, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("editable model control renders selectors and reports changes", () => {
    const onModel = vi.fn();
    render(
      <Conversation
        items={[]}
        onSend={() => {}}
        controls={{ model: "claude-opus-4-8", effort: "high", editable: true, onModel, onEffort: () => {} }}
      />,
    );
    fireEvent.change(screen.getByTitle(/모델/), { target: { value: "claude-sonnet-4-6" } });
    expect(onModel).toHaveBeenCalledWith("claude-sonnet-4-6");
  });

  it("editable controls without effort render only the model selector (live model for a running worker)", () => {
    const onModel = vi.fn();
    render(<Conversation items={[]} onSend={() => {}} controls={{ model: "claude-opus-4-8", editable: true, onModel }} />);
    const selects = screen.getAllByRole("combobox");
    expect(selects).toHaveLength(1); // model only, no effort selector
    fireEvent.change(selects[0], { target: { value: "claude-sonnet-4-6" } });
    expect(onModel).toHaveBeenCalledWith("claude-sonnet-4-6");
  });

  it("read-only controls show a fixed model badge, not a selector (running worker)", () => {
    render(<Conversation items={[]} onSend={() => {}} controls={{ model: "claude-opus-4-8", effort: "high", editable: false }} />);
    expect(screen.getByText(/Opus 4\.8/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull(); // no select (dropdown)
  });

  it("attaching a file adds an inline chip (filename only) and sends as @path", async () => {
    const onAttachFile = vi.fn().mockResolvedValue("/repo/src/a.ts");
    const onSend = vi.fn();
    render(<Conversation items={[]} onSend={onSend} onAttachFile={onAttachFile} />);
    fireEvent.click(screen.getByLabelText("파일 첨부"));
    await waitFor(() => expect(screen.getByText("a.ts")).toBeInTheDocument()); // chip = filename only
    expect(composer().textContent).not.toContain("/repo/src"); // the full path is not shown in the editor
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    expect(onSend).toHaveBeenCalledWith("@/repo/src/a.ts"); // serialized as @path on send
  });

  const CMDS = [
    { id: "review", name: "review", description: "Run a review", action: { type: "insert-prompt" as const, text: "/review" } },
    { id: "commit", name: "commit", description: "Commit changes", action: { type: "insert-prompt" as const, text: "/commit" } },
  ];

  it("shows a / command popup and inserts the pick on Enter (does not send)", () => {
    const onSend = vi.fn();
    render(<Conversation items={[]} onSend={onSend} commands={CMDS} />);
    const ed = composer();
    type(ed, "/rev");
    expect(screen.getByText("/review")).toBeInTheDocument();
    fireEvent.keyDown(ed, { key: "Enter" }); // popup open → pick (not send)
    expect(ed.textContent).toBe("/review ");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("triggers the / popup mid-message (after a space) and replaces only the current token", () => {
    const onSend = vi.fn();
    render(<Conversation items={[]} onSend={onSend} commands={CMDS} />);
    const ed = composer();
    type(ed, "고쳐줘 /rev"); // mid-message, not at the start
    expect(screen.getByText("/review")).toBeInTheDocument();
    fireEvent.keyDown(ed, { key: "Enter" });
    expect(ed.textContent).toBe("고쳐줘 /review "); // preserve preceding text, replace only the current token
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not trigger on a slash attached to a word (a/b)", () => {
    render(<Conversation items={[]} onSend={() => {}} commands={CMDS} />);
    type(composer(), "src/review");
    expect(screen.queryByText("/review")).toBeNull();
  });

  it("Escape closes the / popup", () => {
    render(<Conversation items={[]} onSend={() => {}} commands={CMDS} />);
    type(composer(), "/rev");
    expect(screen.getByText("/review")).toBeInTheDocument();
    fireEvent.keyDown(composer(), { key: "Escape" });
    expect(screen.queryByText("/review")).toBeNull();
  });

  it("reopens the / popup when you keep editing the same query after Escape (BUG-2)", () => {
    render(<Conversation items={[]} onSend={() => {}} commands={CMDS} />);
    const ed = composer();
    type(ed, "/rev");
    expect(screen.getByText("/review")).toBeInTheDocument();
    fireEvent.keyDown(ed, { key: "Escape" });
    expect(screen.queryByText("/review")).toBeNull();
    type(ed, "/revi"); // keep editing → should reopen
    expect(screen.getByText("/review")).toBeInTheDocument();
  });

  it("does not pick a command on Enter while IME composing (BUG-4)", () => {
    render(<Conversation items={[]} onSend={() => {}} commands={CMDS} />);
    const ed = composer();
    type(ed, "/rev");
    expect(screen.getByText("/review")).toBeInTheDocument();
    fireEvent.keyDown(ed, { key: "Enter", isComposing: true }); // IME-confirm Enter → no replacement
    expect(ed.textContent).toBe("/rev");
  });

  it("typing just '/' surfaces more than 8 skills as candidates, including the trailing pull-request (cap 8 → plenty)", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ id: `cmd${i}`, name: `cmd${i}`, description: "d", action: { type: "insert-prompt" as const, text: `/cmd${i}` } }));
    many.push({ id: "pull-request", name: "pull-request", description: "PR 열기", action: { type: "insert-prompt" as const, text: "/pull-request" } });
    render(<Conversation items={[]} onSend={() => {}} commands={many} />);
    type(composer(), "/"); // empty query → all are candidates
    expect(screen.getByText("/pull-request")).toBeInTheDocument(); // index 11 — would not show under the old slice(0,8)
  });

  it("no popup when nothing matches → Enter still sends the text", () => {
    const onSend = vi.fn();
    render(<Conversation items={[]} onSend={onSend} commands={CMDS} />);
    const ed = composer();
    type(ed, "/zzz");
    expect(screen.queryByText(/\/review/)).toBeNull();
    fireEvent.keyDown(ed, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/zzz");
  });
});

describe("Conversation @ file mention", () => {
  const composer = (): HTMLElement => screen.getByRole("textbox", { name: "메시지 입력" });
  const typeAt = setPromptEditorText;
  const makeBrowse = () =>
    vi.fn(async (dir: string) => {
      if (dir === "") return { dir: "/proj", entries: [{ name: "src", isDir: true }, { name: "readme.md", isDir: false, size: 10 }] };
      if (dir === "src/") return { dir: "/proj/src", entries: [{ name: "comp", isDir: true }, { name: "index.ts", isDir: false, size: 5 }] };
      if (dir === "src/comp/") return { dir: "/proj/src/comp", entries: [{ name: "Button.tsx", isDir: false, size: 20 }] };
      return { dir: "/x", entries: [] };
    });

  it("opens a path popup on @, drills folders, attaches the file as an @abs chip", async () => {
    const onSend = vi.fn();
    const browseDir = makeBrowse();
    render(<Conversation items={[]} onSend={onSend} browseDir={browseDir} />);
    const ed = composer();
    typeAt(ed, "@");
    await waitFor(() => expect(screen.getByText("src/")).toBeInTheDocument()); // folders are suffixed with /
    expect(screen.getByText("readme.md")).toBeInTheDocument();
    fireEvent.keyDown(ed, { key: "Enter" }); // drill into src
    await waitFor(() => expect(browseDir).toHaveBeenCalledWith("src/"));
    await waitFor(() => expect(screen.getByText("comp/")).toBeInTheDocument());
    fireEvent.keyDown(ed, { key: "Enter" }); // drill into comp
    await waitFor(() => expect(screen.getByText("Button.tsx")).toBeInTheDocument());
    fireEvent.keyDown(ed, { key: "Enter" }); // attach Button.tsx
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    expect(onSend).toHaveBeenCalledWith("@/proj/src/comp/Button.tsx");
  });

  it("filters within the listed directory as you type (no refetch)", async () => {
    const browseDir = makeBrowse();
    render(<Conversation items={[]} onSend={vi.fn()} browseDir={browseDir} />);
    const ed = composer();
    typeAt(ed, "@read");
    await waitFor(() => expect(screen.getByText("readme.md")).toBeInTheDocument());
    expect(screen.queryByText("src/")).toBeNull(); // "read" filter → excludes src
    expect(browseDir).toHaveBeenCalledTimes(1); // dirPart "" only once (filtering is client-side)
  });

  it("Escape closes the @ popup", async () => {
    const browseDir = makeBrowse();
    render(<Conversation items={[]} onSend={vi.fn()} browseDir={browseDir} />);
    const ed = composer();
    typeAt(ed, "@");
    await waitFor(() => expect(screen.getByText("readme.md")).toBeInTheDocument());
    fireEvent.keyDown(ed, { key: "Escape" });
    expect(screen.queryByText("readme.md")).toBeNull();
  });

  it("does not trigger for an email-like token (foo@bar)", async () => {
    const browseDir = makeBrowse();
    render(<Conversation items={[]} onSend={vi.fn()} browseDir={browseDir} />);
    typeAt(composer(), "mail foo@bar");
    await new Promise((res) => setTimeout(res, 150));
    expect(browseDir).not.toHaveBeenCalled();
    expect(screen.queryByText("readme.md")).toBeNull();
  });
});

describe("MetricsView", () => {
  it("renders the last metrics item's segments", () => {
    const items: LogItem[] = [{ kind: "metrics", contextPct: 25, tokens: 50000, turns: 3, durationMs: 12300, cost: 1.25 }];
    render(<MetricsView items={items} />);
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByText("50.0k tok")).toBeInTheDocument();
    // the test environment has no I18nProvider, so it falls back to ko (metrics render in Korean)
    expect(screen.getByText("3턴")).toBeInTheDocument();
    expect(screen.getByText("$1.25")).toBeInTheDocument();
  });
  it("renders nothing when no metrics item", () => {
    const { container } = render(<MetricsView items={[{ kind: "message", role: "user", content: "x" }]} />);
    expect(container.querySelector("span")).toBeNull();
  });
  it("renders the terminalReason with a fail tone when present", () => {
    const items: LogItem[] = [{ kind: "metrics", contextPct: 25, tokens: 50000, turns: 3, durationMs: 12300, cost: 1.25, terminalReason: "api_error" }];
    render(<MetricsView items={items} />);
    const reason = screen.getByText("⚠ api_error");
    expect(reason).toBeInTheDocument();
    expect(reason).toHaveClass("text-fail");
  });
  it("omits the terminalReason segment when absent", () => {
    const items: LogItem[] = [{ kind: "metrics", contextPct: 25, tokens: 50000, turns: 3, durationMs: 12300, cost: 1.25 }];
    render(<MetricsView items={items} />);
    expect(screen.queryByText(/⚠/)).toBeNull();
  });
});

describe("ConversationPane pending bubbles", () => {
  it("renders pending messages as a queued bubble after committed items", () => {
    useStore.setState({ pendingBySession: { s1: [{ clientMsgId: "c1", text: "대기메시지" }] } } as any);
    render(<ConversationPane kind="master" id="s1" onSend={() => {}} />);
    expect(screen.getByText("대기메시지")).toBeInTheDocument();
    expect(screen.getByText("전송 대기")).toBeInTheDocument(); // pendingBadge (ko fallback)
  });

  it("renders no pending bubbles when pending is empty for that conversation", () => {
    useStore.setState({ pendingBySession: {} } as any);
    render(<ConversationPane kind="master" id="s1" onSend={() => {}} />);
    expect(screen.queryByText("전송 대기")).toBeNull();
  });
});
