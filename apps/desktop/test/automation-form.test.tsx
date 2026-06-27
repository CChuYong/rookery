import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AutomationForm } from "../src/renderer/components/AutomationForm.js";

describe("AutomationForm", () => {
  it("submits a new cron + master automation", () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AutomationForm job="new" repos={[{ name: "app-api", path: "/code/app" }]} onClose={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "nightly" } });
    fireEvent.change(screen.getByLabelText("Cron 식"), { target: { value: "0 3 * * *" } });
    // PromptEditor is a contenteditable div — set its textContent and fire an input event
    const promptEditor = screen.getByLabelText("프롬프트");
    promptEditor.textContent = "summarize";
    fireEvent.input(promptEditor);
    fireEvent.change(screen.getByPlaceholderText("/path/to/repo"), { target: { value: "/some/path" } });
    fireEvent.click(screen.getByText("저장"));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "nightly",
        trigger: expect.objectContaining({ kind: "cron", cron: "0 3 * * *" }),
        action: expect.objectContaining({ kind: "master", prompt: "summarize", cwd: "/some/path" }),
      }),
    );
  });

  it("submits a slack trigger with master action", () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AutomationForm job="new" repos={[{ name: "app-api", path: "/code/app" }]} onClose={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "deploybot" } });
    // switch trigger to slack
    fireEvent.change(screen.getByLabelText("트리거"), { target: { value: "slack" } });
    fireEvent.change(screen.getByLabelText("채널 (쉼표로 구분된 id)"), { target: { value: "C123, C456" } });
    fireEvent.change(screen.getByLabelText("키워드"), { target: { value: "deploy" } });
    // PromptEditor is a contenteditable div — set its textContent and fire an input event
    const promptEditor = screen.getByLabelText("프롬프트");
    promptEditor.textContent = "handle {{message}}";
    fireEvent.input(promptEditor);
    fireEvent.change(screen.getByPlaceholderText("/path/to/repo"), { target: { value: "/some/path" } });
    fireEvent.click(screen.getByText("저장"));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "deploybot",
        trigger: expect.objectContaining({ kind: "slack", channels: ["C123", "C456"], keyword: "deploy" }),
        action: expect.objectContaining({ kind: "master", prompt: "handle {{message}}" }),
      }),
    );
  });

  it("renders the master prompt as a PromptEditor (textbox) and includes it in the payload", async () => {
    const onSubmit = vi.fn(async () => {});
    const { getByLabelText, getByText, getByPlaceholderText } = render(
      <AutomationForm
        job="new"
        repos={[{ name: "app-api", path: "/code/app" }]}
        commands={[{ name: "review", description: "r" }]}
        browseDir={vi.fn(async () => ({ dir: "/code/app", entries: [] }))}
        onClose={() => {}}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(getByLabelText("이름"), { target: { value: "auto1" } });
    fireEvent.change(getByPlaceholderText("/path/to/repo"), { target: { value: "/code/app" } });
    const editor = getByLabelText("프롬프트");
    editor.textContent = "do {{message}}";
    fireEvent.input(editor);
    fireEvent.click(getByText("저장"));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      name: "auto1",
      action: expect.objectContaining({ kind: "master", prompt: "do {{message}}", cwd: "/code/app" }),
    }));
  });

  // ── Task 4: model/effort/permissionMode/maxTurns controls ──

  it("renders model/effort/permissionMode controls in the Model/Execution section", () => {
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={vi.fn()} />);
    // Section heading
    expect(screen.getByText("모델 / 실행")).toBeInTheDocument();
    // permissionMode select is present
    expect(screen.getByLabelText("권한 모드")).toBeInTheDocument();
  });

  it("worker action: permissionMode has only bypassPermissions + plan options, maxTurns input visible", () => {
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={vi.fn()} />);
    // switch to worker action
    fireEvent.change(screen.getByLabelText("액션"), { target: { value: "worker" } });

    const permSelect = screen.getByLabelText("권한 모드") as HTMLSelectElement;
    const options = Array.from(permSelect.options).map((o) => o.value);
    expect(options).toContain("bypassPermissions");
    expect(options).toContain("plan");
    expect(options).not.toContain("default");
    expect(options).not.toContain("acceptEdits");

    // maxTurns input should be visible for worker
    expect(screen.getByLabelText("최대 턴 수")).toBeInTheDocument();
  });

  it("master action: permissionMode has all 4 options, maxTurns hidden", () => {
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={vi.fn()} />);
    // default is master action
    const permSelect = screen.getByLabelText("권한 모드") as HTMLSelectElement;
    const options = Array.from(permSelect.options).map((o) => o.value);
    expect(options).toContain("bypassPermissions");
    expect(options).toContain("default");
    expect(options).toContain("plan");
    expect(options).toContain("acceptEdits");

    // maxTurns input should NOT be visible for master
    expect(screen.queryByLabelText("최대 턴 수")).toBeNull();
  });

  it("bypassPermissions default shows warning; switching to plan hides it", () => {
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={vi.fn()} />);
    // bypass warning is shown by default (bypassPermissions is default)
    const warning = screen.getByTestId("bypass-warning");
    expect(warning).toBeInTheDocument();

    // switch permissionMode to plan
    fireEvent.change(screen.getByLabelText("권한 모드"), { target: { value: "plan" } });
    expect(screen.queryByTestId("bypass-warning")).toBeNull();
  });

  it("submit includes permissionMode and null maxTurns for master action", () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "myjob" } });
    const promptEditor = screen.getByLabelText("프롬프트");
    promptEditor.textContent = "do something";
    fireEvent.input(promptEditor);
    fireEvent.change(screen.getByPlaceholderText("/path/to/repo"), { target: { value: "/code" } });
    fireEvent.click(screen.getByText("저장"));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionMode: "bypassPermissions",
        maxTurns: null, // master: always null
      }),
    );
  });

  it("submit includes permissionMode and maxTurns for worker action", () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AutomationForm job="new" repos={[{ name: "repo1", path: "/r" }]} onClose={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "workerjob" } });
    // switch to worker action
    fireEvent.change(screen.getByLabelText("액션"), { target: { value: "worker" } });
    // fill task
    const taskEditor = screen.getByLabelText("작업");
    taskEditor.textContent = "fix the bug";
    fireEvent.input(taskEditor);
    // set maxTurns
    fireEvent.change(screen.getByLabelText("최대 턴 수"), { target: { value: "10" } });
    fireEvent.click(screen.getByText("저장"));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionMode: "bypassPermissions",
        maxTurns: 10,
      }),
    );
  });

  it("initialises from init prop: permissionMode and maxTurns", () => {
    const job = {
      id: "a1",
      name: "existing",
      enabled: true,
      trigger: { kind: "cron" as const, cron: "0 3 * * *", timezone: "UTC" },
      action: { kind: "worker" as const, repo: "repo1", task: "build" },
      model: "claude-sonnet-4-6",
      effort: "high",
      permissionMode: "plan",
      maxTurns: 5,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      nextRunAt: null,
      createdAt: "t",
    };
    render(<AutomationForm job={job} repos={[{ name: "repo1", path: "/r" }]} onClose={() => {}} onSubmit={vi.fn()} />);
    const permSelect = screen.getByLabelText("권한 모드") as HTMLSelectElement;
    expect(permSelect.value).toBe("plan");
    const maxTurnsInput = screen.getByLabelText("최대 턴 수") as HTMLInputElement;
    expect(maxTurnsInput.value).toBe("5");
    // plan mode: no bypass warning
    expect(screen.queryByTestId("bypass-warning")).toBeNull();
  });
});
