import type { ExecEvent, Sandbox } from 'microsandbox';
import { LOG } from '../common/log.ts';
import { OutputCollector, type ExecRequest, type ExecResult } from '../common/exec.ts';

/**
 * Execute a command inside the sandbox
 */
export async function execInSandbox(sandbox: Sandbox, req: ExecRequest): Promise<ExecResult> {
    const handle = await sandbox.execStreamWith(req.cmd, b => {
        if (req.args?.length) {
            b.args(req.args);
        }
        if (req.root === true) {
            b.user('root');
        }
        if (req.cwd !== undefined) {
            b.cwd(req.cwd);
        }
        if (req.env !== undefined) {
            b.envs(req.env);
        }
        return b;
    });

    let timedOut = false;
    const watchdog = req.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            handle.kill().catch((err: Error) => {
                LOG.warn(`Failed to kill process in sandbox on timeout: ${err.message}`);
            });
        }, req.timeoutMs);

    const stdout = new OutputCollector(req.stream);
    const stderr = new OutputCollector(req.stream);
    let code = -1;
    let spawnFailed = false;
    try {
        // `| undefined`: a command that cannot be started at all -- a missing
        // binary, say -- arrives as a `failed` event, which the SDK (0.7.7)
        // does not know and passes on as undefined.
        for await (const event of handle as AsyncIterable<ExecEvent | undefined>) {
            if (event === undefined) {
                spawnFailed = true;
            } else if (event.kind === 'stdout') {
                stdout.push(event.data);
            } else if (event.kind === 'stderr') {
                stderr.push(event.data);
            } else if (event.kind === 'exited') {
                code = event.code;
            }
        }
    } finally {
        clearTimeout(watchdog);
    }

    if (spawnFailed) {
        // Shell convention for a command that could not be run.
        return { ok: false, code: 127, stdout: '', stderr: `could not start ${req.cmd} in the sandbox`, timedOut };
    }

    return { ok: !timedOut && code === 0, code, stdout: stdout.finish(), stderr: stderr.finish(), timedOut };
}
