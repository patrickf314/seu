// The `seu shell` flow: find the session, give it a Docker daemon, hand over
// the terminal.
//
// Kept apart from the command const in src/cmd/shell.ts so that loading the
// command set does not load the microsandbox SDK.

import type { ExecHandle, Sandbox } from 'microsandbox';
import { LOG } from '../../common/log.ts';
import { die } from '../../common/error.ts';
import { resolveInstance, resolveProject, takeInstanceName } from '../../config/project.ts';
import { requireSession } from '../../session.ts';
import { prepareWork, SRC_MOUNT, startDockerd, WORK_DIR } from '../../sandbox.ts';

export async function run(argv: string[]): Promise<number> {
    const { name, rest } = takeInstanceName(argv);
    for (const arg of rest) die(arg.startsWith('-') ? `unknown option for shell: ${arg}` : `shell takes one name, not ${arg}`);

    const instance = resolveInstance(await resolveProject(), name);
    const session = await requireSession(instance);

    // Only after a resume. On a session that was already up, /work is as the
    // last shell left it, and re-running session-init would quietly carry over
    // whatever the host worktree has changed since.
    if (session.resumed) {
        LOG.step(`Preparing ${WORK_DIR}`);
        await prepareWork(session.sandbox);
    }

    LOG.step('Docker');
    const dockerd = await dockerDaemon(session.sandbox);

    banner(instance.name);

    try {
        return await session.sandbox.attachWith('/bin/bash', (b) =>
            b.args(['--login']).user('seu').cwd(WORK_DIR),
        );
    } finally {
        // Explicit, rather than left to process exit: the handle IS the daemon's
        // supervisor, and a shell that has ended should not leave one behind
        // for the few seconds it takes this process to go away.
        await dockerd?.kill().catch(() => {});
    }
}

/**
 * A shell without Docker is still a usable shell, so a daemon that will not
 * start is a warning here rather than the refusal it is during an install.
 */
async function dockerDaemon(sandbox: Sandbox): Promise<ExecHandle | undefined> {
    try {
        return await startDockerd(sandbox);
    } catch (err) {
        LOG.warn(`dockerd is not available in this session: ${(err as Error).message}`);
        return undefined;
    }
}

/**
 * What is true of the thing you are now inside. A VM shell must never be
 * mistaken for a host shell, and /src being read-only is the one rule that
 * costs you work if you learn it the hard way.
 */
function banner(name: string): void {
    LOG.step(`SEU  ${name}`);
    LOG.debug(`${SRC_MOUNT}    host worktree, READ-ONLY`);
    LOG.debug(`${WORK_DIR}   your writable clone -- commit here, then \`seu pull\` on the host`);
    LOG.debug('net     egress restricted to Anthropic');
    LOG.debug('docker  in-VM daemon; docker compose and Testcontainers work');
    LOG.print('');
}
