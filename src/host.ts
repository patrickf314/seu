// Host-side process plumbing: git, docker and python3 still run on the Mac.
// Only the guest side moved to the microsandbox SDK.

import { spawn } from "node:child_process";
import { die } from "./common/error.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Inherit stderr so a long-running command (docker build) stays visible. */
  showStderr?: boolean;
  /** Write these bytes to the child's stdin, then close it. */
  stdin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", opts.showStderr ? "inherit" : "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin);
    }

    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`${cmd} not found on PATH`));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Run and fail hard; returns trimmed stdout. */
export async function runOk(cmd: string, args: string[], message: string, opts: RunOptions = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim().split("\n").slice(-5).join("\n    ");
    die(detail ? `${message}\n    ${detail}` : message);
  }
  return r.stdout.trim();
}

/** Run with the terminal attached, for commands whose output IS the progress. */
export function runInherit(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", 2, 2] });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });
}

/** True when the command exits 0. Used for the `docker info` style probes. */
export async function succeeds(cmd: string, args: string[]): Promise<boolean> {
  try {
    return (await run(cmd, args)).code === 0;
  } catch {
    return false;
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
