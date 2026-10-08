import { OutputCollector, type ExecRequest, type ExecResult } from '../common/exec.ts';
import { LOG } from '../common/log.ts';
import { spawn } from 'node:child_process';
import { constants } from 'node:os';

/**
 * Grace period between SIGTERM and SIGKILL when a command times out
 */
const KILL_GRACE_MS = 5_000;

/**
 * Execute a command on the host
 */
export function execOnHost(req: ExecRequest): Promise<ExecResult> {
    if (req.root === true) {
        return Promise.reject(new Error(`Executing commands as root is not supported on the host: ${req.cmd}`));
    }

    return new Promise((resolve, reject) => {
        const child = spawn(req.cmd, req.args ?? [], {
            cwd: req.cwd,
            env: { ...process.env, ...req.env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const stdout = new OutputCollector(req.stream);
        const stderr = new OutputCollector(req.stream);
        child.stdout.on('data', (d: Buffer) => stdout.push(d));
        child.stderr.on('data', (d: Buffer) => stderr.push(d));

        let timedOut = false;
        let killTimer: NodeJS.Timeout | undefined;
        const killChildProcess = (signal: NodeJS.Signals): void => {
            try {
                child.kill(signal);
            } catch (err) {
                // ESRCH: the process group is already gone
                if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
                    LOG.warn(`Failed to kill process on host on timeout: ${(err as Error).message}`);
                }
            }
        };
        const watchdog = req.timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                timedOut = true;
                killChildProcess('SIGTERM');
                killTimer = setTimeout(() => killChildProcess('SIGKILL'), KILL_GRACE_MS);
            }, req.timeoutMs);
        const clearTimers = (): void => {
            clearTimeout(watchdog);
            clearTimeout(killTimer);
        };

        child.on('error', (err) => {
            clearTimers();
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                reject(new Error(`${req.cmd} not found on PATH`));
            } else {
                reject(err);
            }
        });

        child.on('close', (code, signal) => {
            clearTimers();

            // Shell convention: a process killed by a signal exits with 128 + signal number
            const exitCode = code ?? (signal ? 128 + constants.signals[signal] : -1);
            resolve({
                ok: !timedOut && exitCode === 0,
                code: exitCode,
                stdout: stdout.finish(),
                stderr: stderr.finish(),
                timedOut,
            });
        });
    });
}
