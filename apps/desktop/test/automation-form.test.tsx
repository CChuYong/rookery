import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { AutomationForm } from "../src/renderer/components/AutomationForm.js";
import { useStore } from "../src/renderer/store/store.js";
import type { CodexModelInfo } from "@daemon/protocol/messages.js";

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

  // ── audit #4: inline error surfaces when onSubmit rejects ──

  it("a rejecting onSubmit surfaces the inline submitError message", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("invalid cron expression"));
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "job" } });
    const promptEditor = screen.getByLabelText("프롬프트");
    promptEditor.textContent = "do it";
    fireEvent.input(promptEditor);
    fireEvent.change(screen.getByPlaceholderText("/path/to/repo"), { target: { value: "/code" } });
    fireEvent.click(screen.getByText("저장"));
    expect(await screen.findByText("invalid cron expression")).toBeInTheDocument();
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
      costBudgetUsd: null,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      nextRunAt: null,
      createdAt: "t",
      provider: "claude",
    };
    render(<AutomationForm job={job} repos={[{ name: "repo1", path: "/r" }]} onClose={() => {}} onSubmit={vi.fn()} />);
    const permSelect = screen.getByLabelText("권한 모드") as HTMLSelectElement;
    expect(permSelect.value).toBe("plan");
    const maxTurnsInput = screen.getByLabelText("최대 턴 수") as HTMLInputElement;
    expect(maxTurnsInput.value).toBe("5");
    // plan mode: no bypass warning
    expect(screen.queryByTestId("bypass-warning")).toBeNull();
  });

  // ── Task 3: provider (claude|codex) selector ──

  it("defaults the provider select to claude and submits provider: claude", () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={onSubmit} />);
    const providerSelect = screen.getByLabelText("에이전트 백엔드") as HTMLSelectElement;
    expect(providerSelect.value).toBe("claude");

    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "job" } });
    const promptEditor = screen.getByLabelText("프롬프트");
    promptEditor.textContent = "do it";
    fireEvent.input(promptEditor);
    fireEvent.change(screen.getByPlaceholderText("/path/to/repo"), { target: { value: "/code" } });
    fireEvent.click(screen.getByText("저장"));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ provider: "claude" }));
  });

  it("selecting provider codex submits provider: codex (master action)", () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("에이전트 백엔드"), { target: { value: "codex" } });

    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "job" } });
    const promptEditor = screen.getByLabelText("프롬프트");
    promptEditor.textContent = "do it";
    fireEvent.input(promptEditor);
    fireEvent.change(screen.getByPlaceholderText("/path/to/repo"), { target: { value: "/code" } });
    fireEvent.click(screen.getByText("저장"));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex" }));
  });

  it("selecting provider codex submits provider: codex (worker action)", () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AutomationForm job="new" repos={[{ name: "repo1", path: "/r" }]} onClose={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("액션"), { target: { value: "worker" } });
    fireEvent.change(screen.getByLabelText("에이전트 백엔드"), { target: { value: "codex" } });

    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "workerjob" } });
    const taskEditor = screen.getByLabelText("작업");
    taskEditor.textContent = "fix the bug";
    fireEvent.input(taskEditor);
    fireEvent.click(screen.getByText("저장"));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex" }));
  });

  it("initialises from init prop: provider codex shows in the select", () => {
    const job = {
      id: "a2",
      name: "existing-codex",
      enabled: true,
      trigger: { kind: "cron" as const, cron: "0 3 * * *", timezone: "UTC" },
      action: { kind: "master" as const, prompt: "p", cwd: "/c", sessionMode: "reuse" as const },
      model: null,
      effort: null,
      permissionMode: "bypassPermissions",
      maxTurns: null,
      costBudgetUsd: null,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      nextRunAt: null,
      createdAt: "t",
      provider: "codex",
    };
    render(<AutomationForm job={job} repos={[{ name: "repo1", path: "/r" }]} onClose={() => {}} onSubmit={vi.fn()} />);
    const providerSelect = screen.getByLabelText("에이전트 백엔드") as HTMLSelectElement;
    expect(providerSelect.value).toBe("codex");
  });

  // ── codex-parity findings [12]/[13]: provider-aware model state + null-catalog free-text ──

  it("[12] switching provider does not carry the other provider's model id into the submitted automation", () => {
    useStore.getState().setCodexModels(null);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={onSubmit} />);
    // pick a Claude model, then flip the provider to codex
    fireEvent.change(screen.getByLabelText("모델"), { target: { value: "claude-sonnet-4-6" } });
    fireEvent.change(screen.getByLabelText("에이전트 백엔드"), { target: { value: "codex" } });
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "job" } });
    const promptEditor = screen.getByLabelText("프롬프트");
    promptEditor.textContent = "do it";
    fireEvent.input(promptEditor);
    fireEvent.change(screen.getByPlaceholderText("/path/to/repo"), { target: { value: "/code" } });
    fireEvent.click(screen.getByText("저장"));
    const submitted = onSubmit.mock.calls[0][0];
    expect(submitted.provider).toBe("codex");
    expect(submitted.model).not.toBe("claude-sonnet-4-6"); // the codex model field is independent, not the stale Claude id
  });

  it("[13] provider codex with an unfetched catalog renders a free-text model input, not the Claude dropdown", () => {
    useStore.getState().setCodexModels(null);
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("에이전트 백엔드"), { target: { value: "codex" } });
    const model = screen.getByLabelText("모델") as HTMLElement;
    expect(model.tagName).toBe("INPUT"); // free-text fallback, matching the spawn/new-session surfaces
    expect(screen.queryByRole("option", { name: /Opus|Sonnet|Haiku/ })).toBeNull(); // no Claude id is pickable for codex
  });

  // ── Task 3 (Track C): codex + non-bypass permissionMode warning ──

  it("shows the codex-bypass warning for provider codex + permissionMode plan", () => {
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("에이전트 백엔드"), { target: { value: "codex" } });
    fireEvent.change(screen.getByLabelText("권한 모드"), { target: { value: "plan" } });
    expect(screen.getByTestId("codex-bypass-warning")).toBeInTheDocument();
  });

  it("hides the codex-bypass warning for provider codex + permissionMode bypassPermissions (default)", () => {
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("에이전트 백엔드"), { target: { value: "codex" } });
    // permissionMode stays at its default (bypassPermissions)
    expect(screen.queryByTestId("codex-bypass-warning")).toBeNull();
  });

  it("hides the codex-bypass warning for provider claude + permissionMode plan", () => {
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("권한 모드"), { target: { value: "plan" } });
    // provider stays at its default (claude)
    expect(screen.queryByTestId("codex-bypass-warning")).toBeNull();
  });

  it("hides the codex-bypass warning for a WORKER action + provider codex + permissionMode plan (workers run plan fine)", () => {
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("액션"), { target: { value: "worker" } });
    fireEvent.change(screen.getByLabelText("에이전트 백엔드"), { target: { value: "codex" } });
    fireEvent.change(screen.getByLabelText("권한 모드"), { target: { value: "plan" } });
    expect(screen.queryByTestId("codex-bypass-warning")).toBeNull();
  });
});

// ── Cost budget guard Task 3: costBudgetUsd field (applies to BOTH master and worker actions) ──

describe("AutomationForm cost budget (cost budget guard Task 3)", () => {
  it("the cost-budget input is visible for a MASTER action (not gated like maxTurns)", () => {
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={vi.fn()} />);
    // default action is master; maxTurns is hidden here but cost budget must still show
    expect(screen.queryByLabelText("최대 턴 수")).toBeNull();
    expect(screen.getByLabelText("비용 예산 (USD)")).toBeInTheDocument();
  });

  it("the cost-budget input is visible for a WORKER action too", () => {
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("액션"), { target: { value: "worker" } });
    expect(screen.getByLabelText("최대 턴 수")).toBeInTheDocument();
    expect(screen.getByLabelText("비용 예산 (USD)")).toBeInTheDocument();
  });

  it("submit includes null costBudgetUsd when left empty, for a MASTER action", () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "myjob" } });
    const promptEditor = screen.getByLabelText("프롬프트");
    promptEditor.textContent = "do something";
    fireEvent.input(promptEditor);
    fireEvent.change(screen.getByPlaceholderText("/path/to/repo"), { target: { value: "/code" } });
    fireEvent.click(screen.getByText("저장"));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ costBudgetUsd: null }));
  });

  it("submit includes a numeric costBudgetUsd for a MASTER action", () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "myjob" } });
    const promptEditor = screen.getByLabelText("프롬프트");
    promptEditor.textContent = "do something";
    fireEvent.input(promptEditor);
    fireEvent.change(screen.getByPlaceholderText("/path/to/repo"), { target: { value: "/code" } });
    fireEvent.change(screen.getByLabelText("비용 예산 (USD)"), { target: { value: "12.5" } });
    fireEvent.click(screen.getByText("저장"));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ costBudgetUsd: 12.5 }));
  });

  it("submit includes a numeric costBudgetUsd for a WORKER action", () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AutomationForm job="new" repos={[{ name: "repo1", path: "/r" }]} onClose={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "workerjob" } });
    fireEvent.change(screen.getByLabelText("액션"), { target: { value: "worker" } });
    const taskEditor = screen.getByLabelText("작업");
    taskEditor.textContent = "fix the bug";
    fireEvent.input(taskEditor);
    fireEvent.change(screen.getByLabelText("비용 예산 (USD)"), { target: { value: "3" } });
    fireEvent.click(screen.getByText("저장"));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ costBudgetUsd: 3 }));
  });

  it("non-numeric, zero, or negative cost budget resolves to null in the payload", () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "myjob" } });
    const promptEditor = screen.getByLabelText("프롬프트");
    promptEditor.textContent = "do something";
    fireEvent.input(promptEditor);
    fireEvent.change(screen.getByPlaceholderText("/path/to/repo"), { target: { value: "/code" } });
    fireEvent.change(screen.getByLabelText("비용 예산 (USD)"), { target: { value: "-1" } });
    fireEvent.click(screen.getByText("저장"));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ costBudgetUsd: null }));
  });

  it("initialises the cost-budget input from init.costBudgetUsd", () => {
    const job = {
      id: "a3",
      name: "existing",
      enabled: true,
      trigger: { kind: "cron" as const, cron: "0 3 * * *", timezone: "UTC" },
      action: { kind: "master" as const, prompt: "p", cwd: "/c", sessionMode: "reuse" as const },
      model: null,
      effort: null,
      permissionMode: "bypassPermissions",
      maxTurns: null,
      costBudgetUsd: 7.25,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      nextRunAt: null,
      createdAt: "t",
      provider: "claude",
    };
    render(<AutomationForm job={job} repos={[{ name: "repo1", path: "/r" }]} onClose={() => {}} onSubmit={vi.fn()} />);
    const input = screen.getByLabelText("비용 예산 (USD)") as HTMLInputElement;
    expect(input.value).toBe("7.25");
  });
});

// ── Codex Model Picker Task 4: model/effort catalog coupling ──

const CODEX_MODELS: CodexModelInfo[] = [
  { id: "gpt-5.5", displayName: "GPT-5.5", defaultEffort: "xhigh", supportedEfforts: ["low", "medium", "high", "xhigh"], isDefault: true },
  { id: "gpt-5.4", displayName: "GPT-5.4", defaultEffort: "medium", supportedEfforts: ["low", "medium", "high"], isDefault: false },
];

describe("AutomationForm codex model+effort dropdowns (Codex Model Picker Task 4)", () => {
  beforeEach(() => {
    useStore.setState({ codexModels: null }); // reset the singleton store before each test
  });

  it("provider codex + codexModels seeded → the model select lists the catalog (+ the default option + out-of-list)", () => {
    useStore.getState().setCodexModels(CODEX_MODELS);
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("에이전트 백엔드"), { target: { value: "codex" } });

    const modelSelect = screen.getByLabelText("모델") as HTMLSelectElement;
    expect(within(modelSelect).getByText("GPT-5.5")).toBeInTheDocument();
    expect(within(modelSelect).getByText("GPT-5.4")).toBeInTheDocument();
    // leading "" default option is preserved
    expect(within(modelSelect).getByText("기본값")).toBeInTheDocument();
  });

  it("an out-of-list saved model value (init.model not in the catalog) is preserved as a selectable option", () => {
    useStore.getState().setCodexModels(CODEX_MODELS);
    const job = {
      id: "a4",
      name: "existing",
      enabled: true,
      trigger: { kind: "cron" as const, cron: "0 3 * * *", timezone: "UTC" },
      action: { kind: "master" as const, prompt: "p", cwd: "/c", sessionMode: "reuse" as const },
      model: "gpt-preview",
      effort: "high",
      permissionMode: "bypassPermissions",
      maxTurns: null,
      costBudgetUsd: null,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      nextRunAt: null,
      createdAt: "t",
      provider: "codex",
    };
    render(<AutomationForm job={job} repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={vi.fn()} />);
    const modelSelect = screen.getByLabelText("모델") as HTMLSelectElement;
    expect(modelSelect.value).toBe("gpt-preview");
    expect(within(modelSelect).getByText("gpt-preview")).toBeInTheDocument();
  });

  it("selecting a codex model sets the effort select's options to its supportedEfforts and pre-selects its defaultEffort", () => {
    useStore.getState().setCodexModels(CODEX_MODELS);
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("에이전트 백엔드"), { target: { value: "codex" } });

    const modelSelect = screen.getByLabelText("모델") as HTMLSelectElement;
    fireEvent.change(modelSelect, { target: { value: "gpt-5.4" } });

    const effortSelect = screen.getByLabelText("effort") as HTMLSelectElement;
    expect(effortSelect.value).toBe("medium"); // gpt-5.4's defaultEffort
    expect(within(effortSelect).queryByText("매우 높음")).toBeNull(); // not in gpt-5.4's supportedEfforts

    fireEvent.change(modelSelect, { target: { value: "gpt-5.5" } });
    expect((screen.getByLabelText("effort") as HTMLSelectElement).value).toBe("xhigh"); // gpt-5.5's defaultEffort
  });

  it("codex + no model selected ('' default) → the effort select is hidden entirely", () => {
    useStore.getState().setCodexModels(CODEX_MODELS);
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("에이전트 백엔드"), { target: { value: "codex" } });
    expect(screen.queryByLabelText("effort")).toBeNull();
  });

  it("codex + codexModels null → free-text model input, NOT the Claude models catalog (finding [13])", () => {
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("에이전트 백엔드"), { target: { value: "codex" } });
    const model = screen.getByLabelText("모델") as HTMLElement;
    // Null catalog falls back to a free-text input (the daemon applies the codex*Model default when empty),
    // never the Claude dropdown, whose ids a codex run would reject.
    expect(model.tagName).toBe("INPUT");
    expect(screen.queryByText("Opus 4.8")).toBeNull();
  });

  it("claude provider (default) → the model select lists the Claude `models` catalog regardless of codexModels", () => {
    useStore.getState().setCodexModels(CODEX_MODELS);
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={vi.fn()} />);
    const modelSelect = screen.getByLabelText("모델") as HTMLSelectElement;
    expect(within(modelSelect).getByText("Opus 4.8")).toBeInTheDocument();
    expect(within(modelSelect).queryByText("GPT-5.5")).toBeNull();
  });

  it("submit carries the selected codex model + its pre-selected effort", () => {
    useStore.getState().setCodexModels(CODEX_MODELS);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<AutomationForm job="new" repos={[{ name: "r", path: "/r" }]} onClose={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("에이전트 백엔드"), { target: { value: "codex" } });
    fireEvent.change(screen.getByLabelText("모델"), { target: { value: "gpt-5.4" } });

    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "job" } });
    const promptEditor = screen.getByLabelText("프롬프트");
    promptEditor.textContent = "do it";
    fireEvent.input(promptEditor);
    fireEvent.change(screen.getByPlaceholderText("/path/to/repo"), { target: { value: "/code" } });
    fireEvent.click(screen.getByText("저장"));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex", model: "gpt-5.4", effort: "medium" }));
  });
});
