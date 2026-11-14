// Synthetic desktop smoke server. Runs no providers and never opens the user's daemon/home.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { openDb } from "../../../dist/persistence/db.js";
import { Repositories } from "../../../dist/persistence/repositories.js";
import { ImageStore } from "../../../dist/daemon/image-store.js";
import { completionEvents } from "./completion.mjs";
const dir =
  process.env.ROOKERY_IMAGE_FIXTURE_DIR ||
  fs.mkdtempSync(path.join(os.tmpdir(), "rookery-image-ui-"));
if (
  !path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep) &&
  !path.resolve(dir).startsWith("/tmp/")
)
  throw Error("Fixture directory must be under a temporary directory");
const home = path.join(dir, "home");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(dir, "sample"), { recursive: true });
fs.writeFileSync(
  path.join(dir, "sample", "README.md"),
  "# Synthetic image attachment fixture\n",
);
fs.writeFileSync(path.join(home, "ws-token"), "synthetic-image-fixture-token", {
  mode: 0o600,
});
const fixture = JSON.parse(
  fs
    .readFileSync(new URL("./fixture.json", import.meta.url), "utf8")
    .replaceAll("/tmp/rookery-speed-images-fixtures", dir),
);
const db = openDb(path.join(home, "fixture.db"));
const store = new ImageStore(home, new Repositories(db));
const port = Number(process.env.ROOKERY_IMAGE_FIXTURE_PORT || 18989);
const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, fixture: "rookery-images", dir }));
});
const wss = new WebSocketServer({ server });
const workerId = "image-worker";
fixture.responses["fleet.list"].fleet = [
  {
    id: workerId,
    sessionId: "aabbccdd",
    label: "Image follow-ups",
    repoPath: path.join(dir, "sample"),
    branch: "rookery/image-fixture",
    model: "claude-opus-4-8",
    provider: "claude",
    status: "idle",
    permissionMode: "bypassPermissions",
    speed: "fast",
  },
];
fixture.workerHistory[workerId] = [];
const sides = new Map();
function broadcast(event) {
  for (const client of wss.clients)
    client.send(JSON.stringify({ type: "event", event }));
}
wss.on("connection", (ws) =>
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    const reply = (value) =>
      ws.send(JSON.stringify({ ...value, reqId: msg.reqId }));
    const event = (value) => broadcast(value);
    try {
      if (msg.type === "image.upload")
        return reply({ type: "image.upload.result", image: store.upload(msg) });
      if (msg.type === "image.get")
        return reply({ type: "image.get.result", ...store.get(msg.id) });
      if (msg.type === "session.history")
        return reply({
          type: "session.history.result",
          sessionId: msg.sessionId,
          events: fixture.sessionHistory[msg.sessionId] || [],
        });
      if (msg.type === "worker.history")
        return reply({
          type: "worker.history.result",
          id: msg.id,
          events: fixture.workerHistory[msg.id] || [],
        });
      if (msg.type === "events.subscribe") return;
      if (msg.type === "session.create") {
        const sessionId = randomUUID();
        fixture.responses["session.list"].sessions.push({
          id: sessionId,
          label: "Image-only session",
          cwd: msg.cwd || path.join(dir, "sample"),
          origin: "ui",
          status: "idle",
          provider: msg.provider || "claude",
          speed: msg.speed ?? null,
          lastActivity: new Date().toISOString(),
        });
        return reply({ type: "session.created", sessionId });
      }
      if (msg.type === "session.send" || msg.type === "worker.send") {
        const images = msg.images?.length
          ? store.validate(msg.images)
          : undefined;
        const master = msg.type === "session.send";
        const id = master ? msg.sessionId : msg.id;
        reply({ type: "fleet.ack", action: "send", id });
        const row = master
          ? fixture.responses["session.list"].sessions.find(
              (row) => row.id === id,
            )
          : fixture.responses["fleet.list"].fleet.find((row) => row.id === id);
        const completion = completionEvents({
          kind: master ? "master" : "worker",
          id,
          provider: row?.provider,
          speed: msg.speed ?? row?.speed ?? "standard",
        });
        if (row) row.status = "running";
        event(completion[0]);
        const history = master
          ? (fixture.sessionHistory[id] ||= [])
          : (fixture.workerHistory[id] ||= []);
        const data = {
          kind: "message",
          role: "user",
          content: msg.text,
          ...(images ? { images } : {}),
          clientMsgId: msg.clientMsgId,
        };
        const payload = master
          ? {
              type: "master.message",
              sessionId: id,
              role: "user",
              content: msg.text,
              ...(images ? { images } : {}),
              clientMsgId: msg.clientMsgId,
            }
          : data;
        history.push({
          seq: history.length,
          type: master ? "master.message" : "message",
          payload,
          createdAt: new Date().toISOString(),
        });
        event(
          master
            ? payload
            : {
                type: "worker.event",
                sessionId: "aabbccdd",
                workerId: id,
                seq: history.length - 1,
                data,
                clientMsgId: msg.clientMsgId,
              },
        );
        for (const frame of completion.slice(1)) {
          if (master && frame.type !== "master.status")
            history.push({
              seq: history.length,
              type: frame.type,
              payload: frame,
              createdAt: new Date().toISOString(),
            });
          if (!master && frame.type === "worker.event") {
            frame.seq = history.length;
            history.push({
              seq: frame.seq,
              type: frame.data.kind,
              payload: frame.data,
              createdAt: new Date().toISOString(),
            });
          }
          event(frame);
        }
        if (row) row.status = "idle";
        return;
      }
      if (msg.type === "side.start") {
        const images = msg.images?.length
          ? store.validate(msg.images)
          : undefined;
        const sideId = randomUUID();
        const row =
          msg.sourceKind === "worker"
            ? fixture.responses["fleet.list"].fleet.find(
                (row) => row.id === msg.sourceId,
              )
            : fixture.responses["session.list"].sessions.find(
                (row) => row.id === msg.sourceId,
              );
        const source = {
          sourceKind: msg.sourceKind,
          sourceId: msg.sourceId,
          provider: row?.provider,
          speed: row?.speed ?? "standard",
        };
        sides.set(sideId, source);
        const completion = completionEvents({
          kind: "side",
          id: sideId,
          ...source,
        });
        reply({ type: "side.started", sideId });
        event(completion[0]);
        event({
          type: "side.event",
          sideId,
          sourceKind: msg.sourceKind,
          sourceId: msg.sourceId,
          data: {
            kind: "message",
            role: "user",
            content: msg.text,
            ...(images ? { images } : {}),
          },
        });
        for (const frame of completion.slice(1)) event(frame);
        return;
      }
      if (msg.type === "side.send") {
        const images = msg.images?.length
          ? store.validate(msg.images)
          : undefined;
        const source = sides.get(msg.sideId);
        if (!source) throw Error("Unknown synthetic Side");
        const completion = completionEvents({
          kind: "side",
          id: msg.sideId,
          ...source,
        });
        reply({ type: "fleet.ack", action: "send", id: msg.sideId });
        event(completion[0]);
        event({
          type: "side.event",
          sideId: msg.sideId,
          ...source,
          data: {
            kind: "message",
            role: "user",
            content: msg.text,
            ...(images ? { images } : {}),
          },
        });
        for (const frame of completion.slice(1)) event(frame);
        return;
      }
      if (msg.type.endsWith(".setSpeed"))
        return reply({
          type: "fleet.ack",
          action: "setSpeed",
          id: msg.id || msg.sessionId,
        });
      if (msg.type === "side.close" || msg.type === "side.stop")
        return reply({ type: "fleet.ack", action: "stop", id: msg.sideId });
      const response = fixture.responses[msg.type];
      if (response) return reply(response);
      reply({
        type: "error",
        message: `Synthetic fixture does not implement ${msg.type}`,
      });
    } catch (error) {
      reply({ type: "error", message: String(error) });
    }
  }),
);
server.listen(port, "127.0.0.1", () => {
  fs.writeFileSync(
    path.join(dir, "fixture-server.json"),
    JSON.stringify({ port: server.address().port, dir }),
  );
  console.log(
    JSON.stringify({
      fixture: "rookery-images",
      dir,
      port: server.address().port,
    }),
  );
});
