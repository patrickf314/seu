import type { Sandbox } from 'microsandbox';
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
    try {
        for await (const event of handle) {
            if (event.kind === 'stdout') {
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

    return { ok: !timedOut && code === 0, code, stdout: stdout.finish(), stderr: stderr.finish(), timedOut };
}
