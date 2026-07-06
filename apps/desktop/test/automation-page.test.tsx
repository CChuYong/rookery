import { it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AutomationPage } from "../src/renderer/components/AutomationPage.js";
import type { Automation } from "@daemon/persistence/repositories.js";

function mkMaster(id: string, prompt: string): Automation {
  return {
    id,
    name: `job-${id}`,
    enabled: true,
    trigger: { kind: "cron", cron: "0 3 * * *", timezone: "UTC" },
    action: { kind: "master", prompt, cwd: "/w", sessionMode: "reuse" },
    model: null,
    effort: null,
    permissionMode: null,
    maxTurns: null,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    nextRunAt: null,
    createdAt: "t",
    provider: "claude",
  };
}

const cronJob: Automation = {
  id: "s1",
  name: "nightly",
  enabled: false,
  trigger: { kind: "cron", cron: "0 3 * * *", timezone: "UTC" },
  action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" },
  model: null,
  effort: null,
  permissionMode: null,
  maxTurns: null,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  nextRunAt: null,
  createdAt: "t",
  provider: "claude",
};

const slackJob: Automation = {
  id: "s2",
  name: "watch",
  enabled: true,
  trigger: { kind: "slack", channels: ["C123"], keyword: "deploy" },
  action: { kind: "worker", repo: "app-api", task: "do it" },
  model: null,
  effort: null,
  permissionMode: null,
  maxTurns: null,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  nextRunAt: null,
  createdAt: "t",
  provider: "claude",
};

it("lists jobs and fires run-now", () => {
  const onRun = vi.fn(() => Promise.resolve());
  render(<AutomationPage automations={[cronJob]} onRun={onRun} onToggle={() => Promise.resolve()} onDelete={() => {}} onEdit={() => {}} onNew={() => {}} />);
  expect(screen.getByText("nightly")).toBeInTheDocument();
  // cron trigger badge shows the cron string
  expect(screen.getByText(/0 3 \* \* \*/)).toBeInTheDocument();
  fireEvent.click(screen.getByTitle("지금 실행"));
  expect(onRun).toHaveBeenCalledWith("s1", undefined);
});

it("shows a slack trigger badge summarizing the filters", () => {
  render(<AutomationPage automations={[slackJob]} onRun={() => Promise.resolve()} onToggle={() => Promise.resolve()} onDelete={() => {}} onEdit={() => {}} onNew={() => {}} />);
  expect(screen.getByText(/slack:/)).toBeInTheDocument();
  expect(screen.getByText(/#C123/)).toBeInTheDocument();
  expect(screen.getByText(/"deploy"/)).toBeInTheDocument();
});

// ─── Slack id → name resolution (audit #51) ────────────────────────────────

it("without onResolveSlackRefs, the raw Slack channel id is shown (no regression, matches Slack-off fallback)", () => {
  render(<AutomationPage automations={[slackJob]} onRun={() => Promise.resolve()} onToggle={() => Promise.resolve()} onDelete={() => {}} onEdit={() => {}} onNew={() => {}} />);
  expect(screen.getByText(/#C123/)).toBeInTheDocument();
});

it("resolves a Slack channel id to its name and renders '#name' once the resolution lands", async () => {
  const onResolveSlackRefs = vi.fn((channels: string[], users: string[]) =>
    Promise.resolve({ channels: Object.fromEntries(channels.map((c) => [c, "general"])), users: Object.fromEntries(users.map((u) => [u, "clover"])) }),
  );
  render(
    <AutomationPage
      automations={[slackJob]}
      onRun={() => Promise.resolve()}
      onToggle={() => Promise.resolve()}
      onDelete={() => {}}
      onEdit={() => {}}
      onNew={() => {}}
      onResolveSlackRefs={onResolveSlackRefs}
    />,
  );
  expect(onResolveSlackRefs).toHaveBeenCalledWith(["C123"], []);
  await waitFor(() => expect(screen.getByText(/#general/)).toBeInTheDocument());
  expect(screen.queryByText(/#C123/)).toBeNull();
});

it("keeps showing the raw id when onResolveSlackRefs rejects (disconnected/unconfigured Slack — no crash)", async () => {
  const onResolveSlackRefs = vi.fn(() => Promise.reject(new Error("disconnected")));
  render(
    <AutomationPage
      automations={[slackJob]}
      onRun={() => Promise.resolve()}
      onToggle={() => Promise.resolve()}
      onDelete={() => {}}
      onEdit={() => {}}
      onNew={() => {}}
      onResolveSlackRefs={onResolveSlackRefs}
    />,
  );
  await waitFor(() => expect(onResolveSlackRefs).toHaveBeenCalled());
  expect(screen.getByText(/#C123/)).toBeInTheDocument();
});

it("does not re-request an id it has already resolved, even if the automations array is re-rendered", async () => {
  const onResolveSlackRefs = vi.fn((channels: string[]) => Promise.resolve({ channels: Object.fromEntries(channels.map((c) => [c, "general"])), users: {} }));
  const { rerender } = render(
    <AutomationPage
      automations={[slackJob]}
      onRun={() => Promise.resolve()}
      onToggle={() => Promise.resolve()}
      onDelete={() => {}}
      onEdit={() => {}}
      onNew={() => {}}
      onResolveSlackRefs={onResolveSlackRefs}
    />,
  );
  await waitFor(() => expect(screen.getByText(/#general/)).toBeInTheDocument());
  // Re-render with a new array/object reference for the same rule (e.g. an unrelated lastStatus refresh) —
  // the effect re-runs (new automations reference) but the per-id cache must suppress a duplicate request.
  rerender(
    <AutomationPage
      automations={[{ ...slackJob }]}
      onRun={() => Promise.resolve()}
      onToggle={() => Promise.resolve()}
      onDelete={() => {}}
      onEdit={() => {}}
      onNew={() => {}}
      onResolveSlackRefs={onResolveSlackRefs}
    />,
  );
  expect(onResolveSlackRefs).toHaveBeenCalledTimes(1);
});

it("shows empty state with no jobs", () => {
  render(<AutomationPage automations={[]} onRun={() => Promise.resolve()} onToggle={() => Promise.resolve()} onDelete={() => {}} onEdit={() => {}} onNew={() => {}} />);
  expect(screen.getByText("아직 자동화가 없어요.")).toBeInTheDocument();
});

// ─── load state (audit #14) ─────────────────────────────────────────────────

it("not loaded → shows a skeleton, not the false-empty 'no jobs' copy", () => {
  const { container } = render(
    <AutomationPage automations={[]} loaded={false} onRun={() => Promise.resolve()} onToggle={() => Promise.resolve()} onDelete={() => {}} onEdit={() => {}} onNew={() => {}} />,
  );
  expect(container.querySelector(".sheen")).not.toBeNull();
  expect(screen.queryByText("아직 자동화가 없어요.")).toBeNull();
});

it("loaded and empty → shows the real empty copy, not the skeleton", () => {
  const { container } = render(
    <AutomationPage automations={[]} loaded={true} onRun={() => Promise.resolve()} onToggle={() => Promise.resolve()} onDelete={() => {}} onEdit={() => {}} onNew={() => {}} />,
  );
  expect(screen.getByText("아직 자동화가 없어요.")).toBeInTheDocument();
  expect(container.querySelector(".sheen")).toBeNull();
});

it("loadFailed && !loaded → shows an error row with a retry button that re-fires the request", () => {
  const onRetry = vi.fn();
  render(
    <AutomationPage automations={[]} loaded={false} loadFailed={true} onRetry={onRetry} onRun={() => Promise.resolve()} onToggle={() => Promise.resolve()} onDelete={() => {}} onEdit={() => {}} onNew={() => {}} />,
  );
  expect(screen.getByText("목록을 불러오지 못했어요")).toBeInTheDocument();
  expect(screen.queryByText("아직 자동화가 없어요.")).toBeNull();
  fireEvent.click(screen.getByText("다시 시도"));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

// ─── RunAutomationDialog tests ───────────────────────────────────────────────

it("automation with {{message}} in prompt → click play → shows {{message}} field only, not {{channel}}; submit fires onRun(id, vars)", () => {
  const onRun = vi.fn(() => Promise.resolve());
  render(
    <AutomationPage
      automations={[mkMaster("a1", "리뷰 {{message}}")]}
      onRun={onRun}
      onToggle={() => Promise.resolve()}
      onDelete={() => {}}
      onEdit={() => {}}
      onNew={() => {}}
    />,
  );
  // click play button
  fireEvent.click(screen.getByTitle("지금 실행"));
  // dialog shows the message field
  expect(screen.getByText("{{message}}")).toBeInTheDocument();
  // channel is not referenced → should NOT appear
  expect(screen.queryByText("{{channel}}")).toBeNull();
  // fill the textarea
  const textarea = screen.getByRole("textbox");
  fireEvent.change(textarea, { target: { value: "please review" } });
  // click the "실행" button inside the dialog (runAutomationDialog.run = "실행" in ko)
  // getAllByRole("button") returns all buttons; the dialog "실행" button text is exactly "실행" (not "지금 실행")
  const runBtn = screen.getAllByRole("button").find((b) => b.textContent === "실행")!;
  fireEvent.click(runBtn);
  expect(onRun).toHaveBeenCalledWith("a1", { message: "please review" });
});

it("automation with no template vars → click play → no dialog, immediate onRun(id)", () => {
  const onRun = vi.fn(() => Promise.resolve());
  render(
    <AutomationPage
      automations={[mkMaster("a2", "check the build")]}
      onRun={onRun}
      onToggle={() => Promise.resolve()}
      onDelete={() => {}}
      onEdit={() => {}}
      onNew={() => {}}
    />,
  );
  fireEvent.click(screen.getByTitle("지금 실행"));
  // No dialog heading
  expect(screen.queryByText("임의 실행")).toBeNull();
  expect(onRun).toHaveBeenCalledWith("a2", undefined);
  expect(onRun).not.toHaveBeenCalledWith("a2", expect.anything());
});

// ─── corrupt badge tests ───────────────────────────────────────────────────────

const corruptJob: Automation = {
  id: "c1",
  name: "broken-job",
  enabled: false,
  corrupt: true,
  trigger: { kind: "cron", cron: "0 * * * *", timezone: "UTC" },
  action: { kind: "master", prompt: "", cwd: "/w", sessionMode: "reuse" },
  model: null,
  effort: null,
  permissionMode: null,
  maxTurns: null,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  nextRunAt: null,
  createdAt: "t",
  provider: "claude",
};

it("corrupt automation row shows corrupt badge (automationPage.corrupt fallback text)", () => {
  render(
    <AutomationPage
      automations={[corruptJob]}
      onRun={() => Promise.resolve()}
      onToggle={() => Promise.resolve()}
      onDelete={() => {}}
      onEdit={() => {}}
      onNew={() => {}}
    />,
  );
  // ko fallback: "설정 손상 — 삭제/재저장"
  expect(screen.getByText("설정 손상 — 삭제/재저장")).toBeInTheDocument();
});

it("normal (non-corrupt) automation row does NOT show corrupt badge", () => {
  render(
    <AutomationPage
      automations={[cronJob]}
      onRun={() => Promise.resolve()}
      onToggle={() => Promise.resolve()}
      onDelete={() => {}}
      onEdit={() => {}}
      onNew={() => {}}
    />,
  );
  expect(screen.queryByText("설정 손상 — 삭제/재저장")).toBeNull();
});

it("corrupt row still has a delete button that confirms then fires onDelete", () => {
  const onDelete = vi.fn();
  render(
    <AutomationPage
      automations={[corruptJob]}
      onRun={() => Promise.resolve()}
      onToggle={() => Promise.resolve()}
      onDelete={onDelete}
      onEdit={() => {}}
      onNew={() => {}}
    />,
  );
  fireEvent.click(screen.getByTitle("삭제"));
  fireEvent.click(screen.getByText("삭제")); // confirm dialog's Delete button
  expect(onDelete).toHaveBeenCalledWith("c1");
});

// ─── delete confirmation (audit #20) ───────────────────────────────────────────

it("delete click opens a confirm dialog and does NOT call onDelete until confirmed", () => {
  const onDelete = vi.fn();
  render(
    <AutomationPage
      automations={[cronJob]}
      onRun={() => Promise.resolve()}
      onToggle={() => Promise.resolve()}
      onDelete={onDelete}
      onEdit={() => {}}
      onNew={() => {}}
    />,
  );
  fireEvent.click(screen.getByTitle("삭제"));
  // confirm dialog shown, with the rule's name in the body — onDelete not yet called
  expect(screen.getByText("자동화 삭제")).toBeInTheDocument();
  expect(screen.getByText(/'nightly' 규칙을 삭제할까요/)).toBeInTheDocument();
  expect(onDelete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("삭제")); // confirm
  expect(onDelete).toHaveBeenCalledWith("s1");
});

it("delete confirm dialog Cancel closes without calling onDelete", async () => {
  const onDelete = vi.fn();
  render(
    <AutomationPage
      automations={[cronJob]}
      onRun={() => Promise.resolve()}
      onToggle={() => Promise.resolve()}
      onDelete={onDelete}
      onEdit={() => {}}
      onNew={() => {}}
    />,
  );
  fireEvent.click(screen.getByTitle("삭제"));
  fireEvent.click(screen.getByText("취소"));
  expect(onDelete).not.toHaveBeenCalled();
  // the dialog unmounts after its exit-transition timeout (useDismissTransition)
  await waitFor(() => expect(screen.queryByText("자동화 삭제")).toBeNull());
});
