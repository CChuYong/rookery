import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, vi, expect, it } from "vitest";
import { Composer } from "../src/renderer/components/Composer.js";
import { ConversationPane } from "../src/renderer/components/ConversationPane.js";
import {
  NewSessionPage,
  NEW_SESSION_DRAFT_KEY,
} from "../src/renderer/components/NewSessionPage.js";
import { SideConversationDrawer } from "../src/renderer/components/SideConversationDrawer.js";
import { useDraftStore } from "../src/renderer/store/drafts.js";
import { setImageClient } from "../src/renderer/lib/image-client.js";
import { clearImageCache } from "../src/renderer/components/MessageImages.js";
import { WsClient } from "../src/renderer/ws/client.js";
import type { SocketLike } from "../src/renderer/ws/client.js";
import { setPromptEditorText } from "./prompt-editor-helpers.js";
const image = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "diagram.png",
  mediaType: "image/png" as const,
  byteLength: 20,
  width: 1,
  height: 1,
};
let requests: Array<Record<string, unknown>>;
let release: (() => void) | undefined;
beforeEach(() => {
  requests = [];
  release = undefined;
  clearImageCache();
  useDraftStore.setState({ byPage: {} });
  const socket: SocketLike = {
    onopen: null,
    onmessage: null,
    onclose: null,
    close() {},
    send(data) {
      const message = JSON.parse(data);
      requests.push(message);
      const respond = () =>
        socket.onmessage?.(
          JSON.stringify({
            type:
              message.type === "image.upload"
                ? "image.upload.result"
                : "image.get.result",
            reqId: message.reqId,
            image,
            base64: "eHl6",
          }),
        );
      if (message.type === "image.upload") release = respond;
      else respond();
    },
  };
  const client = new WsClient(
    () => socket,
    () => {},
  );
  client.start();
  setImageClient(client);
  Object.defineProperty(window, "rookery", {
    configurable: true,
    value: { pickAttachment: vi.fn(async () => null) },
  });
});
afterEach(() => {
  setImageClient(null);
});
function drop(container: HTMLElement, files: File[]) {
  fireEvent.drop(container.firstElementChild!, { dataTransfer: { files } });
}
it("sends image-only input and removes a selected image", async () => {
  const send = vi.fn();
  render(<Composer onSend={send} initialImages={[image]} />);
  fireEvent.click(screen.getByRole("button", { name: "보내기" }));
  expect(send).toHaveBeenCalledWith("", [image]);
  await waitFor(() =>
    expect(screen.queryByText("diagram.png")).not.toBeInTheDocument(),
  );
});
it("removes only the requested image and preserves text", () => {
  render(
    <Composer
      onSend={vi.fn()}
      initialText="keep"
      initialImages={[
        image,
        {
          ...image,
          id: "550e8400-e29b-41d4-a716-446655440001",
          name: "second.png",
        },
      ]}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "diagram.png 이미지 제거" }),
  );
  expect(screen.queryByText("diagram.png")).not.toBeInTheDocument();
  expect(screen.getByText("second.png")).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveTextContent("keep");
});
it("retains exact input on rejected send and allows retry", async () => {
  const send = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(undefined);
  render(
    <Composer onSend={send} initialText="retry" initialImages={[image]} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "보내기" }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  expect(screen.getByText("diagram.png")).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveTextContent("retry");
  fireEvent.click(screen.getByRole("button", { name: "보내기" }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(send.mock.calls[1]).toEqual(["retry", [image]]);
});
it("uploads drops, gates send until accepted, and keeps ordinary @paths", async () => {
  const send = vi.fn(),
    paths = vi.fn(() => ["/repo/readme.txt"]);
  const { container } = render(<Composer onSend={send} onDropFiles={paths} />);
  drop(container, [
    new File(["png"], "diagram.png", { type: "image/png" }),
    new File(["text"], "readme.txt"),
  ]);
  expect(screen.getByRole("button", { name: "보내기" })).toBeDisabled();
  await waitFor(() => expect(release).toBeDefined());
  expect(requests[0]).toMatchObject({
    type: "image.upload",
    name: "diagram.png",
    base64: "cG5n",
  });
  await act(async () => release!());
  expect(screen.getByText("diagram.png")).toBeInTheDocument();
  expect(paths).toHaveBeenCalledWith([
    expect.objectContaining({ name: "readme.txt" }),
  ]);
  fireEvent.click(screen.getByRole("button", { name: "보내기" }));
  expect(send).toHaveBeenCalledWith("@/repo/readme.txt", [image]);
});
it.each([
  ["bad.svg", "image/svg+xml", 1, "PNG"],
  ["huge.png", "image/png", 3 * 1024 * 1024 + 1, "3 MiB"],
])(
  "rejects %s before reading or uploading",
  async (name, type, size, detail) => {
    const { container } = render(
      <Composer onSend={vi.fn()} initialImages={[image]} />,
    );
    const file = new File(["x"], name as string, { type: type as string });
    Object.defineProperty(file, "size", { value: size });
    drop(container, [file]);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(detail as string),
    );
    expect(requests.filter((r) => r.type === "image.upload")).toHaveLength(0);
    expect(screen.getByText("diagram.png")).toBeInTheDocument();
  },
);
it("preserves text from a clipboard containing both image and text", async () => {
  const send = vi.fn();
  render(<Composer onSend={send} />);
  fireEvent.paste(screen.getByRole("textbox"), {
    clipboardData: {
      files: [new File(["png"], "diagram.png", { type: "image/png" })],
      types: ["text/plain", "Files"],
      getData: (type: string) => (type === "text/plain" ? "explain this" : ""),
    },
  });
  await waitFor(() => expect(release).toBeDefined());
  await act(async () => release!());
  expect(screen.getByRole("textbox")).toHaveTextContent("explain this");
  fireEvent.click(screen.getByRole("button", { name: "보내기" }));
  expect(send).toHaveBeenCalledWith("explain this", [image]);
});
it("uses only bytes returned by the native picker, and preserves selected normal paths", async () => {
  const pick = vi
    .fn()
    .mockResolvedValueOnce({
      name: "diagram.png",
      mediaType: "image/png",
      byteLength: 3,
      base64: "cG5n",
    })
    .mockResolvedValueOnce({ path: "/repo/a.ts" });
  window.rookery.pickAttachment = pick;
  const send = vi.fn();
  render(<Composer onSend={send} />);
  fireEvent.click(screen.getByRole("button", { name: "파일 첨부" }));
  await waitFor(() => expect(release).toBeDefined());
  await act(async () => release!());
  fireEvent.click(screen.getByRole("button", { name: "파일 첨부" }));
  await waitFor(() => expect(screen.getByText("a.ts")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "보내기" }));
  expect(send).toHaveBeenCalledWith("@/repo/a.ts", [image]);
});
it("does not place late imports into another target after navigation", async () => {
  const draftA = vi.fn(),
    draftB = vi.fn();
  const { container, rerender } = render(
    <Composer key="a" onSend={vi.fn()} onDraftChange={draftA} />,
  );
  drop(container, [new File(["png"], "diagram.png", { type: "image/png" })]);
  await waitFor(() => expect(release).toBeDefined());
  rerender(
    <Composer
      key="b"
      onSend={vi.fn()}
      initialText="other"
      onDraftChange={draftB}
    />,
  );
  await act(async () => release!());
  expect(screen.queryByText("diagram.png")).not.toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveTextContent("other");
  expect(draftB).not.toHaveBeenCalled();
});
it("keeps attachments while refusing a client slash action", () => {
  const send = vi.fn(),
    action = vi.fn();
  render(
    <Composer
      onSend={send}
      onCommandAction={action}
      initialImages={[image]}
      initialText="/mcp"
      commands={[
        {
          id: "mcp",
          name: "mcp",
          description: "MCP",
          action: {
            type: "open-capability-center",
            tab: "effective",
            kind: "mcp",
          },
        },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "보내기" }));
  expect(action).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(screen.getByText("diagram.png")).toBeInTheDocument();
});
it.each(["master", "worker"] as const)(
  "%s supports image-only Side start and retains failed source drafts",
  async (kind) => {
    useDraftStore.getState().setDraft_("target", "", [image]);
    const start = vi
      .fn()
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValue("side");
    render(
      <ConversationPane
        kind={kind}
        id="target"
        onSend={vi.fn()}
        onSideStart={start}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "별도로 질문하기" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(useDraftStore.getState().byPage.target.images).toEqual([image]);
    expect(screen.getByText("diagram.png")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "별도로 질문하기" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start.mock.calls[1]).toEqual(["", [image]]);
  },
);
it("starts a new Master with image-only draft and keeps a failed creation draft", async () => {
  useDraftStore.getState().setDraft_(NEW_SESSION_DRAFT_KEY, "", [image]);
  const start = vi.fn().mockRejectedValue(new Error("create failed"));
  render(
    <NewSessionPage
      repos={[]}
      defaultModel="m"
      defaultEffort="high"
      onStart={start}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "시작" }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({ images: [image] }),
  );
  expect(useDraftStore.getState().byPage.newSession.images).toEqual([image]);
});
it("Side follow-up accepts image-only draft", async () => {
  useDraftStore.getState().setDraft_("side:side", "", [image]);
  const send = vi.fn().mockResolvedValue(undefined);
  render(
    <SideConversationDrawer
      sideId="side"
      sourceKind="master"
      openingQuestion="question"
      onSend={send}
      onStop={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "보내기" }));
  await waitFor(() => expect(send).toHaveBeenCalledWith("side", "", [image]));
});
it("can compose a follow-up as soon as enqueue acceptance arrives while the model stays busy", async () => {
  let accept!: () => void;
  const send = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        accept = resolve;
      }),
  );
  render(
    <Composer busy onStop={vi.fn()} onSend={send} initialImages={[image]} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "보내기" }));
  expect(screen.getByText("diagram.png")).toBeInTheDocument();
  await act(async () => accept());
  setPromptEditorText(screen.getByRole("textbox"), "next");
  expect(screen.getByRole("button", { name: "보내기" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "중단" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "보내기" }));
  expect(send).toHaveBeenCalledTimes(2);
});
it("terminal Worker restores retry refs into its draft and offers recovery without sending to a terminated worker", async () => {
  const { useStore } = await import("../src/renderer/store/store.js");
  useStore.setState({
    workerLogs: {
      terminal: [
        {
          kind: "failedInput",
          text: "recover me",
          images: [image],
          clientMsgId: "failed",
          error: "missing",
        },
      ],
    },
    fleet: {},
    pendingByWorker: {},
    historyLoaded: { terminal: true },
  });
  const send = vi.fn(),
    recover = vi.fn();
  render(
    <ConversationPane
      kind="worker"
      id="terminal"
      disabled
      onSend={send}
      onRecover={recover}
    />,
  );
  expect(screen.queryByRole("button", { name: "다시 보내기" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "입력 복원" }));
  expect(useDraftStore.getState().byPage.terminal).toEqual({
    text: "recover me",
    images: [image],
  });
  expect(screen.getByRole("textbox")).toHaveTextContent("recover me");
  fireEvent.click(screen.getByRole("button", { name: "워커 복구" }));
  expect(recover).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
});
it.each([
  ["count", 4, 20, "4개"],
  ["total", 2, 3 * 1024 * 1024, "8 MiB"],
] as const)(
  "rejects batch %s limits before upload and preserves prior refs",
  async (_reason, count, bytes, detail) => {
    const images = Array.from({ length: count }, (_, n) => ({
      ...image,
      id: `550e8400-e29b-41d4-a716-44665544000${n}`,
      name: `${n}.png`,
      byteLength: bytes,
    }));
    const { container } = render(
      <Composer onSend={vi.fn()} initialImages={images} />,
    );
    const file = new File(["png"], "new.png", { type: "image/png" });
    Object.defineProperty(file, "size", { value: 3 * 1024 * 1024 });
    drop(container, [file]);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(detail),
    );
    expect(requests.filter((r) => r.type === "image.upload")).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: /이미지 제거/ })).toHaveLength(
      count,
    );
  },
);
it('closing Side while it prepares preserves the source image draft and closes the late Side',async()=>{
 let opened!:(id:string)=>void;
 const start=vi.fn(()=>new Promise<string>(resolve=>{opened=resolve;}));const close=vi.fn();
 useDraftStore.getState().setDraft_('cancel-side','question',[image]);
 render(<ConversationPane kind="master" id="cancel-side" onSend={vi.fn()} onSideStart={start} onSideClose={close}/>);
 fireEvent.click(screen.getByRole('button',{name:'별도로 질문하기'}));
 fireEvent.click(screen.getByRole('button',{name:'닫기'}));
 await act(async()=>opened('late-side'));
 expect(close).toHaveBeenCalledWith('late-side');expect(useDraftStore.getState().byPage['cancel-side']).toEqual({text:'question',images:[image]});
 expect(screen.getByRole('textbox')).toHaveTextContent('question');expect(screen.getByText('diagram.png')).toBeInTheDocument();
});
