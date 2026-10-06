// Guest-side plumbing shared by every seu command: the volume layout, bounded
// execs, and dockerd. Port of the sandbox half of lib/common.sh, on top of the
// microsandbox SDK instead of the `msb` CLI.

import type { ExecHandle, Sandbox } from "microsandbox";
import { sdk } from "./microsandbox/microsandboxSdk.ts";
import { sleep } from "./host.ts";
import { LOG } from "./common/log.ts";
import { die } from "./common/error.ts";

export const RESOURCES = {
  cpus: 4,
  memoryMiB: 10 * 1024,
  rootDiskMiB: 20 * 1024,
  idleTimeoutSecs: 60 * 60,
};

export const VOLUME_MOUNT = "/seu";
export const VOLUME_SIZE_MIB = 20 * 1024;

export const volumeName = (slug: string): string => `seu-${slug}-data`;

export async function ensureVolume(slug: string): Promise<string> {
  const name = volumeName(slug);
  const { Volume } = await sdk();
  const existing = await Volume.list();
  if (existing.some((v) => v.name === name)) {
    LOG.debug(`volume ${name} exists`);
  } else {
    await Volume.builder(name).disk().size(VOLUME_SIZE_MIB).create();
    LOG.ok(`volume ${name} (${VOLUME_SIZE_MIB / 1024} GiB)`);
  }
  return name;
}

/**
 * Creates the directory layout inside the named volume. Must run before
 * anything resolves /work, ~/.m2 or ~/.cache: those are symlinks into /seu, and
 * the volume mounts empty the first time. This is also why no sandbox is
 * created with a /work workdir -- the image's workdir is validated at create
 * time, when the symlink still dangles.
 */
export async function bootstrapVolume(sandbox: Sandbox): Promise<void> {
  const out = await exec(sandbox, {
    cmd: "sh",
    args: [
      "-c",
      "mkdir -p /seu/work /seu/m2 /seu/cache /seu/docker && chown seu:seu /seu /seu/work /seu/m2 /seu/cache",
    ],
    user: "root",
    timeoutMs: 60_000,
  });
  if (!out.ok) die("could not bootstrap the /seu volume layout");
}

export interface ExecRequest {
  cmd: string;
  args?: string[];
  user?: string;
  env?: Record<string, string>;
  cwd?: string;
  /** Host-side watchdog. Anything that could hang must set one. */
  timeoutMs?: number;
  /** Stream stdout/stderr to the terminal as it arrives. */
  stream?: boolean;
}

export interface ExecResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  /** True when the host-side watchdog killed it. */
  timedOut: boolean;
}

/**
 * A bounded exec.
 *
 * The CLI's `--timeout` never worked -- it neither returned nor killed the
 * command when the budget expired -- so bash grew a host-side watchdog. The SDK
 * exposes a real handle with kill(), so the watchdog is a timer that kills it.
 */
export async function exec(sandbox: Sandbox, req: ExecRequest): Promise<ExecResult> {
  const handle: ExecHandle = await sandbox.execStreamWith(req.cmd, (b) => {
    if (req.args?.length) b.args(req.args);
    if (req.user) b.user(req.user);
    if (req.cwd) b.cwd(req.cwd);
    if (req.env) b.envs(req.env);
    return b;
  });

  let timedOut = false;
  const watchdog =
    req.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          void handle.kill().catch(() => {});
        }, req.timeoutMs);

  let stdout = "";
  let stderr = "";
  let code = -1;
  try {
    for await (const event of handle) {
      if (event.kind === "stdout") {
        stdout += Buffer.from(event.data).toString();
        if (req.stream) process.stderr.write(event.data);
      } else if (event.kind === "stderr") {
        stderr += Buffer.from(event.data).toString();
        if (req.stream) process.stderr.write(event.data);
      } else if (event.kind === "exited") {
        code = event.code;
      }
    }
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }

  return { ok: !timedOut && code === 0, code, stdout, stderr, timedOut };
}

/** Exec, or fail the command with `message` plus the guest's own complaint. */
export async function execOk(sandbox: Sandbox, req: ExecRequest, message: string): Promise<ExecResult> {
  const result = await exec(sandbox, req);
  if (!result.ok) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-5).join("\n    ");
    die(result.timedOut ? `${message} (timed out)` : detail ? `${message}\n    ${detail}` : message);
  }
  return result;
}

/**
 * Wait until the guest agent serves execs.
 *
 * Creation returns before agentd is necessarily ready, and an exec issued in
 * that window used to wedge forever. A bounded exec is the only honest probe:
 * ping exits non-zero even for a reachable sandbox.
 */
export async function waitForAgent(sandbox: Sandbox): Promise<void> {
  for (let i = 0; i < 45; i++) {
    const probe = await exec(sandbox, { cmd: "true", user: "root", timeoutMs: 10_000 });
    if (probe.ok) return;
    await sleep(1000);
  }
  die(`${sandbox.name}: the guest agent never became ready`);
}

/**
 * dockerd, running in the foreground of a streamed exec we deliberately never
 * await. See vm/dockerd-run.sh for why neither a backgrounded guest process nor
 * --init works. The handle is the pidfile's replacement: killing it is what
 * stops the daemon, and it dies with this process either way.
 *
 * Retried: on a freshly booted VM containerd sometimes loses its own startup
 * race and dockerd dies with "failed to start containerd: timeout waiting for
 * containerd to start". A second attempt against the now-warm guest succeeds.
 */
export async function startDockerd(sandbox: Sandbox): Promise<ExecHandle | undefined> {
  if (await dockerdRunning(sandbox)) {
    LOG.debug("dockerd already running");
    return undefined;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    const handle = await sandbox.execStreamWith("/usr/local/bin/dockerd-run.sh", (b) => b.user("root"));
    // Drain the stream so the guest is never blocked on a full pipe; the log
    // itself lives in /var/log/dockerd.log inside the VM.
    void (async () => {
      try {
        for await (const _event of handle) void _event;
      } catch {
        /* the handle was killed at teardown */
      }
    })();

    for (let i = 0; i < 30; i++) {
      if (await dockerdRunning(sandbox)) {
        LOG.ok("dockerd ready");
        return handle;
      }
      await sleep(2000);
    }

    await handle.kill().catch(() => {});
    if (attempt < 3) LOG.warn(`dockerd did not come up (attempt ${attempt}/3); retrying`);
  }

  LOG.warn("dockerd failed to start after 3 attempts");
  const log = await exec(sandbox, {
    cmd: "sh",
    args: ["-c", "tail -20 /var/log/dockerd.log"],
    user: "root",
    timeoutMs: 20_000,
  });
  for (const line of log.stdout.trim().split("\n")) LOG.warn(`    ${line}`);
  return die("dockerd failed to start");
}

async function dockerdRunning(sandbox: Sandbox): Promise<boolean> {
  const probe = await exec(sandbox, {
    cmd: "sh",
    args: ["-c", "docker info >/dev/null 2>&1"],
    user: "root",
    timeoutMs: 20_000,
  });
  return probe.ok;
}
