import { describe, it, expect } from "vitest";
import { TerminalManager } from "../src/main/terminal-manager.js";
import { setMainLocale } from "../src/main/i18n.js";

function makeFakePtys() {
  const ptys: any[] = [];
  const spawn = (shell: string, _args: string[], opts: any) => {
    let dataCb = (_: string) => {};
    let exitCb = (_: any) => {};
    const pty = {
      shell, opts, killed: false, written: [] as string[], resized: null as any,
      onData: (cb: any) => { dataCb = cb; },
      onExit: (cb: any) => { exitCb = cb; },
      write: (d: string) => pty.written.push(d),
      resize: (c: number, r: number) => { pty.resized = { c, r }; },
      kill: () => { pty.killed = true; },
      emit: (d: string) => dataCb(d),
      exit: (code: number) => exitCb({ exitCode: code }),
    };
    ptys.push(pty);
    return pty;
  };
  return { spawn, ptys };
}

function setup(over: Record<string, unknown> = {}) {
  const sent: Array<{ ch: string; p: unknown }> = [];
  const { spawn, ptys } = makeFakePtys();
  let n = 0;
  const mgr = new TerminalManager({
    spawn,
    send: (ch, p) => sent.push({ ch, p }),
    rookeryHome: "/home/me/.rookery",
    exists: (p: string) => p === "/code/app" || p.startsWith("/home/me/.rookery/worktrees/exists"),
    homeDir: "/home/me",
    idgen: () => `t${n++}`,
    env: {},
    ...over,
  });
  return { mgr, sent, ptys };
}

describe("TerminalManager", () => {
  it("create spawns a pty at the session cwd and lists it", () => {
    const { mgr, ptys } = setup();
    const r = mgr.create({ sessionId: "s1", cwd: "/code/app" });
    expect(r.id).toBe("t0");
    expect(ptys[0].opts.cwd).toBe("/code/app");
    expect(mgr.list("s1")).toEqual([{ id: "t0", title: "app", cwd: "/code/app", exited: false }]);
  });

  it("resolves cwd: sub worktree > session cwd > home", () => {
    const { mgr } = setup();
    expect(mgr.resolveCwd({ subId: "exists1", cwd: "/code/app" })).toBe("/home/me/.rookery/worktrees/exists1");
    expect(mgr.resolveCwd({ subId: "gone", cwd: "/code/app" })).toBe("/code/app");
    expect(mgr.resolveCwd({ cwd: "/nonexistent" })).toBe("/home/me");
  });

  it("buffers output and replays scrollback on attach, then forwards live", () => {
    const { mgr, ptys, sent } = setup();
    mgr.create({ sessionId: "s1", cwd: "/code/app" });
    ptys[0].emit("before");
    expect(sent).toHaveLength(0);
    expect(mgr.attach("t0")).toEqual({ scrollback: "before" });
    ptys[0].emit("after");
    expect(sent).toEqual([{ ch: "term:data", p: { id: "t0", data: "after" } }]);
  });

  it("detach stops forwarding but keeps the pty alive", () => {
    const { mgr, ptys, sent } = setup();
    mgr.create({ sessionId: "s1", cwd: "/code/app" });
    mgr.attach("t0");
    mgr.detach("t0");
    ptys[0].emit("x");
    expect(sent).toHaveLength(0);
    mgr.write("t0", "ls\n");
    expect(ptys[0].written).toEqual(["ls\n"]);
    expect(ptys[0].killed).toBe(false);
  });

  it("write and resize delegate to the pty", () => {
    const { mgr, ptys } = setup();
    mgr.create({ sessionId: "s1", cwd: "/code/app" });
    mgr.write("t0", "echo hi\n");
    mgr.resize("t0", 100, 30);
    expect(ptys[0].written).toEqual(["echo hi\n"]);
    expect(ptys[0].resized).toEqual({ c: 100, r: 30 });
  });

  it("trims the scrollback ring to ringLimit", () => {
    const { mgr, ptys } = setup({ ringLimit: 10 });
    mgr.create({ sessionId: "s1", cwd: "/code/app" });
    ptys[0].emit("0123456789ABCDE");
    expect(mgr.attach("t0").scrollback).toBe("56789ABCDE");
  });

  it("on pty exit emits term:exit and keeps the entry as exited", () => {
    const { mgr, ptys, sent } = setup();
    mgr.create({ sessionId: "s1", cwd: "/code/app" });
    ptys[0].exit(0);
    expect(sent).toContainEqual({ ch: "term:exit", p: { id: "t0", exitCode: 0, signal: undefined } });
    expect(mgr.list("s1")).toEqual([{ id: "t0", title: "app", cwd: "/code/app", exited: true }]);
  });

  it("kill terminates the pty and removes it", () => {
    const { mgr, ptys } = setup();
    mgr.create({ sessionId: "s1", cwd: "/code/app" });
    mgr.kill("t0");
    expect(ptys[0].killed).toBe(true);
    expect(mgr.list("s1")).toEqual([]);
  });

  it("killSession terminates only that session's terminals", () => {
    const { mgr, ptys } = setup();
    mgr.create({ sessionId: "s1", cwd: "/code/app" });
    mgr.create({ sessionId: "s2", cwd: "/code/app" });
    mgr.killSession("s1");
    expect(ptys[0].killed).toBe(true);
    expect(ptys[1].killed).toBe(false);
    expect(mgr.list("s1")).toEqual([]);
    expect(mgr.list("s2")).toHaveLength(1);
  });

  it("rejects creating more than maxPerSession terminals", () => {
    setMainLocale("ko"); // pin the i18n error message to Korean for verification
    const { mgr } = setup({ maxPerSession: 2 });
    expect(mgr.create({ sessionId: "s1", cwd: "/code/app" }).id).toBe("t0");
    expect(mgr.create({ sessionId: "s1", cwd: "/code/app" }).id).toBe("t1");
    const r = mgr.create({ sessionId: "s1", cwd: "/code/app" });
    expect(r.id).toBeUndefined();
    expect(r.error).toMatch(/최대 2개/);
  });

  it("killAll terminates every terminal", () => {
    const { mgr, ptys } = setup();
    mgr.create({ sessionId: "s1", cwd: "/code/app" });
    mgr.create({ sessionId: "s2", cwd: "/code/app" });
    mgr.killAll();
    expect(ptys.every((p) => p.killed)).toBe(true);
  });
});
