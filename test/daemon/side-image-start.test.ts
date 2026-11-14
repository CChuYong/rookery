import { it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ImageStore } from "../../src/daemon/image-store.js";
import { Connection } from "../../src/daemon/connection.js";
import { SideConversationManager } from "../../src/core/side-conversation.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { FleetOrchestrator } from "../../src/core/fleet-orchestrator.js";
import { FakeGitOps } from "../../src/core/git-ops.js";
import { EventBus, type CoreEvent } from "../../src/core/events.js";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import type { ServerMessage } from "../../src/protocol/messages.js";
import {
  WsClient,
  type SocketLike,
} from "../../apps/desktop/src/renderer/ws/client.js";
import { fakeBackend } from "../helpers/fake-query.js";

it.each([true, false])(
  "Side start with unreadable-during-fork=%s settles one observable request and preserves success ordering",
  async (removeDuringFork) => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "rookery-side-image-start-"),
    );
    const db = openDb(":memory:");
    const repos = new Repositories(db);
    const bus = new EventBus();
    const images = new ImageStore(home, repos);
    const base64 = fs
      .readFileSync(new URL("../fixtures/images/tiny.png", import.meta.url))
      .toString("base64");
    const image = images.upload({
      name: "tiny.png",
      mediaType: "image/png",
      base64,
    });
    const backend = fakeBackend([
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0,
        num_turns: 1,
        session_id: "sdk-side",
      },
    ]);
    const startTurn = vi.spyOn(backend, "startTurn");
    const cleanup = vi.fn();
    const sides = new SideConversationManager(
      {
        images,
        bus,
        backends: { claude: backend },
        cleanup,
        resolveSource: () => ({
          sourceKind: "master",
          sourceId: "source",
          sessionId: "source",
          provider: "claude",
          cwd: "/tmp",
          sdkSessionId: "sdk-source",
          model: "m",
        }),
        async forkSession() {
          await Promise.resolve();
          if (removeDuringFork)
            fs.unlinkSync(path.join(home, "images", image.id));
          return { sessionId: "fake-fork" };
        },
      },
      () => "side-1",
    );
    const fleet = new FleetOrchestrator({
      repos,
      bus,
      images,
      git: new FakeGitOps(),
      factory: () => {
        throw new Error("No worker expected");
      },
      worktreesDir: path.join(home, "worktrees"),
    });
    const sessions = new SessionManager({
      repos,
      bus,
      images,
      backends: { claude: backend },
      masterModel: "m",
      fleet,
    });
    const replies: ServerMessage[] = [];
    const events: CoreEvent[] = [];
    let connection: Connection;
    const socket: SocketLike = {
      onopen: null,
      onmessage: null,
      onclose: null,
      send(data) {
        void connection.handleRaw(data);
      },
      close() {
        this.onclose?.();
      },
    };
    const client = new WsClient(
      () => socket,
      (event) => events.push(event),
    );
    connection = new Connection(
      {
        send(data) {
          const reply = JSON.parse(data) as ServerMessage;
          replies.push(reply);
          // Once acknowledged, execution must use prepared bytes without reopening the asset.
          if (!removeDuringFork && reply.type === "side.started")
            fs.unlinkSync(path.join(home, "images", image.id));
          socket.onmessage?.({ data });
        },
      },
      sessions,
      bus,
      fleet,
      repos,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sides,
      undefined,
      undefined,
      images,
    );
    client.start();
    client.send({ type: "events.subscribe" });
    try {
      const result = client.request({
        type: "side.start",
        sourceKind: "master",
        sourceId: "source",
        text: "",
        images: [image],
      });
      if (removeDuringFork) {
        await expect(result).rejects.toThrow(/unreadable.*retry/);
        expect(
          replies.filter((reply) => "reqId" in reply && reply.reqId),
        ).toEqual([
          {
            type: "error",
            message: expect.stringMatching(/unreadable.*retry/),
            reqId: "q0",
          },
        ]);
        expect(startTurn).not.toHaveBeenCalled();
        expect(events).toEqual([]);
        expect(cleanup).toHaveBeenCalledTimes(1);
        await expect(sides.idle("side-1")).rejects.toThrow(
          "unknown Side conversation",
        );
      } else {
        expect(await result).toEqual({
          type: "side.started",
          sideId: "side-1",
          reqId: "q0",
        });
        await sides.idle("side-1");
        expect(startTurn).toHaveBeenCalledWith(
          { text: "", images: [{ mediaType: "image/png", data: base64 }] },
          expect.anything(),
        );
        const started = replies.findIndex(
          (reply) => reply.type === "side.started",
        );
        const firstEvent = replies.findIndex(
          (reply) =>
            reply.type === "event" &&
            (reply.event.type === "side.event" ||
              reply.event.type === "side.status"),
        );
        expect(started).toBeGreaterThanOrEqual(0);
        expect(firstEvent).toBeGreaterThan(started);
        expect(events[0]).toMatchObject({
          type: "side.event",
          sideId: "side-1",
          data: { kind: "message", role: "user", content: "", images: [image] },
        });
        expect(
          replies.filter((reply) => "reqId" in reply && reply.reqId),
        ).toHaveLength(1);
      }
    } finally {
      client.stop();
      connection.dispose();
      await sides.closeAll();
      db.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);
