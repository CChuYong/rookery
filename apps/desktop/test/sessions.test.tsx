import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Sessions } from "../src/renderer/views/Sessions.js";

const mk = (over: Record<string, unknown>) => ({ id: "s1", cwd: "/code/app", status: "active", lastActivity: new Date().toISOString(), origin: "ui", ...over });

describe("Sessions provider badge (interop QW1)", () => {
  it("shows a Codex badge on a codex-provider session row, none on a claude one", () => {
    const { unmount } = render(<Sessions sessions={[mk({ id: "s1", label: "cxsess", provider: "codex" })] as never} activeId={null} onSelect={() => {}} />);
    expect(screen.getByText("Codex")).toBeInTheDocument();
    unmount();
    render(<Sessions sessions={[mk({ id: "s2", label: "clsess" })] as never} activeId={null} onSelect={() => {}} />);
    expect(screen.queryByText("Codex")).toBeNull();
  });
});

describe("Sessions context menu + archive", () => {
  it("right-click → rename/archive/delete; archive calls onArchive; delete confirms then onDelete", () => {
    const onArchive = vi.fn();
    const onDelete = vi.fn();
    render(<Sessions sessions={[mk({ id: "s1", label: "app" })] as never} activeId={null} onSelect={() => {}} onArchive={onArchive} onDelete={onDelete} onRename={vi.fn()} />);
    fireEvent.contextMenu(screen.getByText("app"));
    expect(screen.getByText("보관")).toBeInTheDocument();
    fireEvent.click(screen.getByText("보관"));
    expect(onArchive).toHaveBeenCalledWith("s1", true);
    fireEvent.contextMenu(screen.getByText("app"));
    fireEvent.click(screen.getByText("삭제…"));
    expect(screen.getByText("세션 삭제")).toBeInTheDocument(); // confirm dialog
    fireEvent.click(screen.getByText("삭제")); // confirm the action
    expect(onDelete).toHaveBeenCalledWith("s1");
  });

  it("archived sessions live in a collapsed Archive section", () => {
    render(<Sessions sessions={[mk({ id: "s1", label: "active1" }), mk({ id: "s2", label: "arch1", archived: true })] as never} activeId={null} onSelect={() => {}} />);
    expect(screen.getByText("active1")).toBeInTheDocument();
    expect(screen.queryByText("arch1")).toBeNull(); // collapsed → hidden
    fireEvent.click(screen.getByText(/보관함/));
    expect(screen.getByText("arch1")).toBeInTheDocument(); // visible once expanded
  });

  it("shows a live pulse on sessions whose master turn is running", () => {
    render(<Sessions sessions={[mk({ id: "s1", label: "busy1" }), mk({ id: "s2", label: "idle1" })] as never} activeId={null} running={{ s1: true }} onSelect={() => {}} />);
    expect(screen.getAllByTitle("작업 중")).toHaveLength(1); // only s1 pulses
  });

  it("shows an unread dot for attention sessions, but not for the active (viewing) one", () => {
    render(<Sessions sessions={[mk({ id: "s1", label: "done1" }), mk({ id: "s2", label: "seen1" })] as never} activeId={"s2"} attention={{ s1: true, s2: true }} onSelect={() => {}} />);
    expect(screen.getAllByTitle(/새 응답/)).toHaveLength(1); // only s1 (s2 excluded since it's active)
  });
});

describe("Sessions pin + hover actions", () => {
  it("floats pinned sessions into a Pinned section", () => {
    render(<Sessions activeId={null} onSelect={() => {}} sessions={[
      mk({ id: "p", label: "pinned1", pinned: true }),
      mk({ id: "n", label: "normal1" }),
    ] as never} />);
    expect(screen.getByText("고정")).toBeInTheDocument(); // section header
    expect(screen.getByText("pinned1")).toBeInTheDocument();
    expect(screen.getByText("normal1")).toBeInTheDocument();
  });

  it("hover Pin button toggles pin via onPin", () => {
    const onPin = vi.fn();
    render(<Sessions activeId={null} onSelect={() => {}} onPin={onPin} sessions={[mk({ id: "s1", label: "row", pinned: false })] as never} />);
    fireEvent.click(screen.getByTitle("고정")); // hover Pin button (title)
    expect(onPin).toHaveBeenCalledWith("s1", true);
  });

  it("hover Pin on a pinned session unpins it", () => {
    const onPin = vi.fn();
    render(<Sessions activeId={null} onSelect={() => {}} onPin={onPin} sessions={[mk({ id: "s1", label: "row", pinned: true })] as never} />);
    fireEvent.click(screen.getByTitle("고정 해제"));
    expect(onPin).toHaveBeenCalledWith("s1", false);
  });

  it("hover Delete opens the confirm then calls onDelete", () => {
    const onDelete = vi.fn();
    render(<Sessions activeId={null} onSelect={() => {}} onDelete={onDelete} sessions={[mk({ id: "s1", label: "row" })] as never} />);
    fireEvent.click(screen.getByTitle("삭제")); // hover Delete button (title=common.delete)
    fireEvent.click(screen.getByText("삭제")); // run the confirm dialog
    expect(onDelete).toHaveBeenCalledWith("s1");
  });
});

describe("Sessions overflow '⋯' button (audit #45)", () => {
  it("is reachable by role/name and opens the same menu as right-click (Rename/Fork visible)", () => {
    render(<Sessions activeId={null} onSelect={() => {}} onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} onDelete={vi.fn()} sessions={[mk({ id: "s1", label: "row" })] as never} />);
    // audit #78: the overflow button's accessible name says which row it acts on (was a bare "더보기" on every row)
    const moreBtn = screen.getByRole("button", { name: "row 더보기" });
    fireEvent.click(moreBtn);
    expect(screen.getByText("이름 변경")).toBeInTheDocument();
    expect(screen.getByText("포크")).toBeInTheDocument();
  });

  it("clicking a menu item opened via '⋯' invokes the corresponding callback", () => {
    const onFork = vi.fn();
    render(<Sessions activeId={null} onSelect={() => {}} onFork={onFork} sessions={[mk({ id: "s1", label: "row" })] as never} />);
    fireEvent.click(screen.getByRole("button", { name: "row 더보기" }));
    fireEvent.click(screen.getByText("포크"));
    expect(onFork).toHaveBeenCalledWith("s1");
  });
});

describe("Sessions source segmentation + automation grouping", () => {
  it("uses a compact source select instead of the wide segment in a narrow sidebar", () => {
    const onFilter = vi.fn();
    render(<Sessions compact activeId={null} onSelect={() => {}} filter={{ source: "all" }} onFilter={onFilter} sessions={[
      mk({ id: "u", label: "uirow", origin: "ui" }),
      mk({ id: "a", label: "autorow", origin: "automation", originRef: "auto1" }),
    ] as never} />);
    const source = screen.getByRole("combobox", { name: "세션 출처" });
    expect(screen.queryByRole("tablist")).toBeNull();
    fireEvent.change(source, { target: { value: "automation" } });
    expect(onFilter).toHaveBeenCalledWith({ source: "automation" });
  });

  it("shows a 3-way origin badge (ui / slack / auto)", () => {
    render(<Sessions activeId={null} onSelect={() => {}} sessions={[
      mk({ id: "u", label: "uirow", origin: "ui" }),
      mk({ id: "s", label: "slackrow", origin: "slack" }),
      mk({ id: "a", label: "autorow", origin: "automation", originRef: "auto1" }),
    ] as never} />);
    expect(screen.getByText("auto")).toBeInTheDocument(); // new automation badge
    expect(screen.getByText("slack")).toBeInTheDocument();
    expect(screen.getByText("ui")).toBeInTheDocument();
  });

  it("renders a source segment when >1 source and switches filter on click", () => {
    const onFilter = vi.fn();
    render(<Sessions activeId={null} onSelect={() => {}} filter={{ source: "all" }} onFilter={onFilter} sessions={[
      mk({ id: "u", label: "uirow", origin: "ui" }),
      mk({ id: "a", label: "autorow", origin: "automation", originRef: "auto1" }),
    ] as never} />);
    fireEvent.click(screen.getByText("자동화"));
    expect(onFilter).toHaveBeenCalledWith({ source: "automation" });
  });

  it("filters out other sources when a source is selected", () => {
    render(<Sessions activeId={null} onSelect={() => {}} filter={{ source: "automation" }} automations={[{ id: "auto1", name: "Nightly" }] as never} sessions={[
      mk({ id: "u", label: "uirow", origin: "ui" }),
      mk({ id: "a", label: "autorow", origin: "automation", originRef: "auto1" }),
    ] as never} />);
    expect(screen.queryByText("uirow")).toBeNull(); // ui sessions hidden
    expect(screen.getByText("autorow")).toBeInTheDocument();
  });

  it("groups automation sessions under their automation name (resolved from automations)", () => {
    render(<Sessions activeId={null} onSelect={() => {}} filter={{ source: "automation" }} automations={[
      { id: "auto1", name: "Nightly build" }, { id: "auto2", name: "Daily report" },
    ] as never} sessions={[
      mk({ id: "a1", label: "run-a", origin: "automation", originRef: "auto1" }),
      mk({ id: "a2", label: "run-b", origin: "automation", originRef: "auto2" }),
    ] as never} />);
    expect(screen.getByText("Nightly build")).toBeInTheDocument(); // group header = automation name
    expect(screen.getByText("Daily report")).toBeInTheDocument();
  });

  it("hides origin badges when a specific source tab is active (tab already says the source)", () => {
    render(<Sessions activeId={null} onSelect={() => {}} filter={{ source: "automation" }} automations={[{ id: "a1", name: "Job" }] as never} sessions={[
      mk({ id: "x", label: "runrow", origin: "automation", originRef: "a1" }),
    ] as never} />);
    expect(screen.getByText("runrow")).toBeInTheDocument();
    expect(screen.queryByText("auto")).toBeNull(); // badge hidden — the tab already indicates the source
  });

  it("still shows badges in the 전체(All) view where sources are mixed", () => {
    render(<Sessions activeId={null} onSelect={() => {}} filter={{ source: "all" }} sessions={[
      mk({ id: "s", label: "slackrow", origin: "slack" }),
      mk({ id: "u", label: "uirow", origin: "ui" }),
    ] as never} />);
    expect(screen.getByText("slack")).toBeInTheDocument(); // mixed sources, so keep the badges
    expect(screen.getByText("ui")).toBeInTheDocument();
  });

  it("orders the segment with present sources first and All last", () => {
    render(<Sessions activeId={null} onSelect={() => {}} filter={{ source: "all" }} sessions={[
      mk({ id: "u", label: "u", origin: "ui" }),
      mk({ id: "a", label: "a", origin: "automation", originRef: "x" }),
    ] as never} />);
    const auto = screen.getByText("자동화");
    const all = screen.getByText("전체");
    // 'All' comes after 'Automation' (put All last so externally-driven activity isn't mixed in by default).
    expect(auto.compareDocumentPosition(all) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("with a specific source filter shows only that source (separated by default)", () => {
    render(<Sessions activeId={null} onSelect={() => {}} filter={{ source: "ui" }} sessions={[
      mk({ id: "u", label: "mine", origin: "ui" }),
      mk({ id: "s", label: "fromslack", origin: "slack" }),
    ] as never} />);
    expect(screen.getByText("mine")).toBeInTheDocument();
    expect(screen.queryByText("fromslack")).toBeNull(); // slack isn't mixed in by default
  });

  it("falls back to the first present source when the selected source is empty", () => {
    render(<Sessions activeId={null} onSelect={() => {}} filter={{ source: "ui" }} sessions={[
      mk({ id: "s", label: "onlyslack", origin: "slack" }),
    ] as never} />);
    expect(screen.getByText("onlyslack")).toBeInTheDocument(); // no ui sessions → fall back to slack (avoid an empty default tab)
  });

  it("falls back to a deleted-automation label when the automation is gone", () => {
    render(<Sessions activeId={null} onSelect={() => {}} filter={{ source: "automation" }} automations={[] as never} sessions={[
      mk({ id: "a1", label: "orphan-run", origin: "automation", originRef: "gone" }),
    ] as never} />);
    expect(screen.getByText("(삭제된 자동화)")).toBeInTheDocument();
  });

  it("active session stays visible even when the source filter would otherwise exclude it (audit #21)", () => {
    render(<Sessions activeId="s" onSelect={() => {}} filter={{ source: "ui" }} sessions={[
      mk({ id: "u", label: "uirow", origin: "ui" }),
      mk({ id: "s", label: "slackrow", origin: "slack" }), // active, but filtered to 'ui' — must still show
    ] as never} />);
    expect(screen.getByText("uirow")).toBeInTheDocument();
    expect(screen.getByText("slackrow")).toBeInTheDocument(); // the active session isn't hidden by the filter
  });
});

describe("Sessions initial load failure (audit #14)", () => {
  it("loadFailed && !loaded → shows an error row (not the empty copy) with a retry button that re-fires the request", () => {
    const onRetry = vi.fn();
    render(<Sessions sessions={[]} activeId={null} onSelect={() => {}} loaded={false} loadFailed={true} onRetry={onRetry} />);
    expect(screen.getByText("목록을 불러오지 못했어요")).toBeInTheDocument();
    expect(screen.queryByText("아직 대화가 없어요 — 위 ‘새 세션’으로 마스터에게 일을 맡겨보세요.")).toBeNull();
    fireEvent.click(screen.getByText("다시 시도"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // audit #42: still loading → skeleton rows, not a blank column.
  it("still loading → a skeleton, neither the empty copy nor the error row", () => {
    const { container } = render(<Sessions sessions={[]} activeId={null} onSelect={() => {}} loaded={false} loadFailed={false} />);
    expect(container.querySelector(".sheen")).not.toBeNull();
    expect(screen.queryByText("목록을 불러오지 못했어요")).toBeNull();
  });

  // audit #44: retry shows progress and says so when it fails again.
  it("retry is busy while the request runs and reports a second failure", async () => {
    let fail!: (e: Error) => void;
    const onRetry = vi.fn(() => new Promise<void>((_res, rej) => { fail = rej; }));
    render(<Sessions sessions={[]} activeId={null} onSelect={() => {}} loaded={false} loadFailed={true} onRetry={onRetry} />);
    const btn = screen.getByRole("button", { name: "다시 시도" });
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-busy", "true");
    await act(async () => { fail(new Error("timeout")); });
    expect(await screen.findByText(/다시 시도했지만 실패했어요/)).toBeInTheDocument();
  });

  it("loaded but empty → shows the normal empty copy, not the error row", () => {
    render(<Sessions sessions={[]} activeId={null} onSelect={() => {}} loaded={true} loadFailed={false} />);
    expect(screen.getByText("아직 대화가 없어요 — 위 ‘새 세션’으로 마스터에게 일을 맡겨보세요.")).toBeInTheDocument();
    expect(screen.queryByText("목록을 불러오지 못했어요")).toBeNull();
  });
});

describe("Sessions fallback-name disambiguating subline (audit #46)", () => {
  it("a fallback-named session (no explicit title) shows a dim relative-time subline", () => {
    render(<Sessions sessions={[mk({ id: "s1", cwd: "/code/app" })] as never} activeId={null} onSelect={() => {}} />);
    expect(screen.getByText("app")).toBeInTheDocument(); // name came from baseName(cwd)
    expect(screen.getByText("방금")).toBeInTheDocument(); // lastActivity = now → 'just now'
  });

  it("a session with an explicit title stays single-line (no subline noise)", () => {
    render(<Sessions sessions={[mk({ id: "s1", label: "My Title" })] as never} activeId={null} onSelect={() => {}} />);
    expect(screen.getByText("My Title")).toBeInTheDocument();
    expect(screen.queryByText("방금")).toBeNull();
  });
});

// audit #118: RepoTree had a text filter past a handful of workers; Sessions had none.
describe("Sessions text filter (audit #118)", () => {
  const many = Array.from({ length: 9 }, (_, i) => mk({ id: `s${i}`, label: i === 4 ? "release cadence" : `chat ${i}` }));
  it("appears once there are more than 8 sessions and filters rows by name", () => {
    render(<Sessions sessions={many as never} activeId={null} onSelect={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("세션 필터…"), { target: { value: "CADENCE" } });
    expect(screen.getByText("release cadence")).toBeInTheDocument();
    expect(screen.queryByText("chat 1")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("세션 필터…"), { target: { value: "nothing-like-this" } });
    expect(screen.getByText("일치하는 세션이 없어요.")).toBeInTheDocument();
  });
  // review m5
  it("doesn't claim 'no matches' while the open session is still listed, and filters the archive too", () => {
    const withArchived = [...many, mk({ id: "a1", label: "old cadence notes", archived: true }), mk({ id: "a2", label: "old chat", archived: true })];
    render(<Sessions sessions={withArchived as never} activeId="s1" onSelect={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("세션 필터…"), { target: { value: "nothing-like-this" } });
    expect(screen.getByText("chat 1")).toBeInTheDocument(); // the open session stays visible
    expect(screen.queryByText("일치하는 세션이 없어요.")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("세션 필터…"), { target: { value: "cadence" } });
    fireEvent.click(screen.getByText(/보관함/));
    expect(screen.getByText("old cadence notes")).toBeInTheDocument();
    expect(screen.queryByText("old chat")).toBeNull();
  });

  // review round 2: matches only in the archive → no "no matches" line above an archive that has them.
  it("doesn't say 'no matches' when only archived sessions match", () => {
    const withArchived = [...many, mk({ id: "a1", label: "zebra notes", archived: true })];
    render(<Sessions sessions={withArchived as never} activeId={null} onSelect={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("세션 필터…"), { target: { value: "zebra" } });
    expect(screen.queryByText("일치하는 세션이 없어요.")).toBeNull();
    expect(screen.getByText(/보관함/)).toBeInTheDocument();
  });

  it("stays hidden for a short list", () => {
    render(<Sessions sessions={many.slice(0, 3) as never} activeId={null} onSelect={() => {}} />);
    expect(screen.queryByPlaceholderText("세션 필터…")).toBeNull();
  });
});

// audit #107 #76 #77 #78: one tab stop per list, Arrow keys between rows, the open row marked aria-current, keyboard
// paths for the row actions, named action buttons, a labelled rename input that ignores the IME's committing Enter.
describe("Sessions keyboard + accessible names (audit T11)", () => {
  const rows = [mk({ id: "a", label: "alpha" }), mk({ id: "b", label: "beta" }), mk({ id: "c", label: "gamma" })];

  it("is a single tab stop on the open session, with Arrow navigation and aria-current", () => {
    render(<Sessions activeId="b" onSelect={() => {}} onPin={vi.fn()} onDelete={vi.fn()} sessions={rows as never} />);
    const beta = screen.getByText("beta").closest("button")!;
    const alpha = screen.getByText("alpha").closest("button")!;
    expect(beta).toHaveAttribute("aria-current", "page");
    expect(beta).toHaveAttribute("tabindex", "0");
    expect(alpha).toHaveAttribute("tabindex", "-1");
    // the hover actions are not extra tab stops per row
    expect(screen.getByRole("button", { name: "beta 삭제" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: "beta 고정" })).toHaveAttribute("tabindex", "-1");
    beta.focus();
    fireEvent.keyDown(beta, { key: "ArrowUp" });
    expect(document.activeElement).toBe(alpha);
  });

  it("opens the row menu on Shift+F10, renames on F2 and asks to delete on Delete", () => {
    const onDelete = vi.fn();
    render(<Sessions activeId={null} onSelect={() => {}} onRename={vi.fn()} onDelete={onDelete} onPin={vi.fn()} sessions={[mk({ id: "s1", label: "row" })] as never} />);
    const row = screen.getByText("row").closest("button")!;
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "고정" })).toBeInTheDocument(); // pin has a keyboard path now
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(row, { key: "Delete" });
    expect(screen.getByText("세션 삭제")).toBeInTheDocument();
  });

  it("labels the rename input and ignores the Enter that commits an IME syllable", () => {
    const onRename = vi.fn();
    render(<Sessions activeId={null} onSelect={() => {}} onRename={onRename} sessions={[mk({ id: "s1", label: "row" })] as never} />);
    fireEvent.keyDown(screen.getByText("row").closest("button")!, { key: "F2" });
    const input = screen.getByRole("textbox", { name: "row 이름 변경" });
    fireEvent.change(input, { target: { value: "새 이름" } });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onRename).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("s1", "새 이름");
  });
});
