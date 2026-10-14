// The trace viewer itself: Playwright's `show-trace`, served from inside the
// session. Nothing here knows about traces on disk or the host side forward.

import type { ExecHandle, Sandbox } from 'microsandbox';
import { LOG } from '../common/log.ts';
import { die } from '../common/error.ts';
import { sleep } from '../common/utils.ts';
import { WORK_DIR } from '../common/constants.ts';
import { execInSandbox } from '../msb/exec.ts';

/**
 * A cold `mvn exec:java` is slow, and the driver unpacks its node bundle on
 * first use, so this budget is generous on purpose.
 */
const READY_TIMEOUT_MS = 2 * 60_000;

export interface Viewer {
    readonly handle: ExecHandle;
    /**
     * Resolves once the viewer process is gone, for whatever reason.
     */
    readonly exited: Promise<'exited'>;
    /**
     * What it printed, kept for when it dies before opening its port.
     */
    readonly output: string[];
}

/**
 * `-o` because the session has no network to Maven Central. `--host/--port` is
 * what makes show-trace SERVE the viewer rather than launch Playwright's bundled
 * browser app; it still tries to open a tab in the guest, where there is no
 * browser to show it, but Playwright swallows that failure and keeps serving.
 *
 * Every value reaches the command through the environment, so the paths -- as
 * validated as they are -- never become shell syntax.
 */
export async function startViewer(sandbox: Sandbox, pom: string, trace: string, port: number): Promise<Viewer> {
    const handle = await sandbox.execStreamWith('bash', b => b
        .args([
            '-lc',
            'exec mvn -B -o exec:java --file "$SEU_POM" ' +
            '-Dexec.mainClass=com.microsoft.playwright.CLI ' +
            '-Dexec.args="show-trace --host 127.0.0.1 --port $SEU_PORT $SEU_TRACE"',
        ])
        .user('seu')
        .cwd(WORK_DIR)
        .envs({ SEU_POM: pom, SEU_PORT: String(port), SEU_TRACE: `${WORK_DIR}/${trace}` }),
    );

    return watchProcess(handle);
}

/**
 * Follows a long-lived guest process: what it prints is kept (the last 200
 * lines) and `exited` resolves when it is gone.
 */
export function watchProcess(handle: ExecHandle): Viewer {
    const output: string[] = [];
    const exited = (async (): Promise<'exited'> => {
        try {
            for await (const event of handle) {
                if (event.kind === 'stdout' || event.kind === 'stderr') {
                    output.push(...Buffer.from(event.data).toString().split('\n').filter((l) => l !== ''));
                    output.splice(0, Math.max(0, output.length - 200));
                }
            }
        } catch {
            /* the handle was killed at teardown */
        }
        return 'exited';
    })();

    return { handle, exited, output };
}

/**
 * Until something listens on the guest port, the viewer dies, or time runs out.
 */
export async function waitForViewer(
    sandbox: Sandbox,
    viewer: Viewer,
    port: number,
    what = 'the trace viewer',
): Promise<void> {
    let gone = false;
    void viewer.exited.then(() => (gone = true));

    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (gone) {
            report(viewer);
            die(`${what} exited before it opened a port`);
        }

        const probe = await execInSandbox(sandbox, {
            cmd: 'bash',
            args: ['-c', `exec 3<>/dev/tcp/127.0.0.1/${port}`],
            timeoutMs: 10_000,
        });
        if (probe.ok) return;
        await sleep(2000);
    }

    report(viewer);
    die(`${what} never opened vm:${port}`);
}

function report(viewer: Viewer): void {
    for (const line of viewer.output.slice(-15)) {
        LOG.debug(`    ${line}`);
    }
}
