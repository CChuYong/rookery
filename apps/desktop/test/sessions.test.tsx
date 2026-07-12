import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
    const moreBtn = screen.getByRole("button", { name: "더보기" });
    fireEvent.click(moreBtn);
    expect(screen.getByText("이름 변경")).toBeInTheDocument();
    expect(screen.getByText("포크")).toBeInTheDocument();
  });

  it("clicking a menu item opened via '⋯' invokes the corresponding callback", () => {
    const onFork = vi.fn();
    render(<Sessions activeId={null} onSelect={() => {}} onFork={onFork} sessions={[mk({ id: "s1", label: "row" })] as never} />);
    fireEvent.click(screen.getByRole("button", { name: "더보기" }));
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
