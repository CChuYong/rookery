import fs from "node:fs";
import fsp from "node:fs/promises";

export interface WorkflowFileStat {
  size: number;
  mtimeMs: number;
  isFile: boolean;
}

export interface WorkflowDirectoryWatch {
  close(): void;
}

export interface ClaudeWorkflowFiles {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<WorkflowFileStat>;
  read(path: string, offset: number, length: number): Promise<Buffer>;
  readText(path: string, maxBytes: number): Promise<string>;
  watchDirectory(path: string, onChange: (name: string | null) => void): WorkflowDirectoryWatch;
}

export const realClaudeWorkflowFiles: ClaudeWorkflowFiles = {
  realpath: (file) => fsp.realpath(file),
  stat: async (file) => {
    const stat = await fsp.stat(file);
    return { size: stat.size, mtimeMs: stat.mtimeMs, isFile: stat.isFile() };
  },
  read: async (file, offset, length) => {
    const handle = await fsp.open(file, "r");
    try {
      const buffer = Buffer.alloc(Math.max(0, length));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
  readText: async (file, maxBytes) => {
    if (maxBytes <= 0) return "";
    const stat = await fsp.stat(file);
    const length = Math.min(stat.size, Math.max(0, maxBytes) + (stat.size > maxBytes ? 1 : 0));
    const offset = Math.max(0, stat.size - length);
    const handle = await fsp.open(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      if (offset === 0) return text.slice(-maxBytes);
      const newline = text.indexOf("\n");
      return newline === -1 ? "" : text.slice(newline + 1);
    } finally {
      await handle.close();
    }
  },
  watchDirectory: (dir, onChange) => {
    const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => onChange(filename?.toString() ?? null));
    watcher.on("error", () => onChange(null));
    return { close: () => watcher.close() };
  },
};
