import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { query, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "../../src/core/claude-backend.js";

// Run the installed SDK's real independent input/output pumps over an in-memory process.
// No model/account/network or child process is used. Unlike fakeQuery, a rejected input control
// follows SDK streamInput(...).catch(error => abortController.abort(error)).
export function sdkQueryProcess(options: { rejectFlagAt?: number; holdFlagAt?: number } = {}) {
  const controls: string[] = [];
  const delivered: string[] = [];
  const controllers: AbortController[] = [];
  const processes: SpawnedProcess[] = [];
  let flagCalls = 0;
  const queryFn: QueryFn = input => {
    if (input.options?.abortController) controllers.push(input.options.abortController);
    return query({ ...input, options: { ...input.options, spawnClaudeCodeProcess: () => {
      const proc = Object.assign(new EventEmitter(), {
        killed: false,
        exitCode: null as number | null,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new Writable(),
        kill(signal: NodeJS.Signals) {
          if (proc.killed) return true;
          proc.killed = true;
          proc.exitCode = 0;
          proc.emit("exit", 0, signal);
          proc.stdout.end();
          proc.stderr.end();
          return true;
        },
      });
      const emit = (frame: unknown) => proc.stdout.write(JSON.stringify(frame) + "\n");
      let pending = "";
      proc.stdin = new Writable({ write(chunk, _encoding, callback) {
        pending += chunk.toString();
        while (pending.includes("\n")) {
          const index = pending.indexOf("\n");
          const raw = pending.slice(0, index); pending = pending.slice(index + 1);
          if (!raw) continue;
          const message = JSON.parse(raw);
          if (message.type === "control_request") {
            const subtype = message.request.subtype;
            controls.push(subtype);
            if (subtype === "apply_flag_settings") {
              flagCalls++;
              if (flagCalls === options.holdFlagAt) continue;
            }
            const response = subtype === "apply_flag_settings" && flagCalls === options.rejectFlagAt
              ? { subtype: "error", request_id: message.request_id, error: "account rejected fast mode" }
              : { subtype: "success", request_id: message.request_id, response: { commands: [], models: [] } };
            emit({ type: "control_response", response });
          } else if (message.type === "user") {
            delivered.push(message.message.content);
            emit({ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "sdk-process-test" });
          }
        }
        callback();
      } });
      processes.push(proc);
      return proc;
    } } });
  };
  return { queryFn, controls, delivered, controllers, processes, close() { for (const proc of processes) proc.kill("SIGTERM"); } };
}
