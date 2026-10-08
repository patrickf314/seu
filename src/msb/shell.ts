import type { ExecHandle, Sandbox } from 'microsandbox';
import type { SeuConfig } from '../config/config.ts';
import type { Session } from './session.ts';
import { resolveSecrets } from '../config/secrets.ts';
import { WORK_DIR } from '../common/constants.ts';
import { startDockerd } from './sandbox.ts';
import { LOG } from '../common/log.ts';

/**
 * Give the session a Docker daemon and the profile's secrets, and hand the
 * terminal over, until the shell ends. Also how `seu start` finishes.
 */
export async function shell(config: SeuConfig, session: Session): Promise<number> {
    return attachLoginShell(config, session, ['--login']);
}

/**
 * Like {@link shell}, but the login shell execs straight into `claude` --
 * unless `claude.dangerouslySkipPermissions` is off, with permission prompts
 * off: the VM is the boundary they would otherwise be. `args` are passed on to
 * claude as they are, never as shell syntax.
 */
export async function claude(config: SeuConfig, session: Session, args: readonly string[]): Promise<number> {
    const flags = config.claude.dangerouslySkipPermissions ? ['--dangerously-skip-permissions'] : [];
    return attachLoginShell(config, session, [
        '--login', '-c', 'exec claude "$@"', 'claude', ...flags, ...args,
    ]);
}

async function attachLoginShell(config: SeuConfig, session: Session, bashArgs: string[]): Promise<number> {
    const secrets = await resolveSecrets(config);

    LOG.step('Docker');
    const dockerd = await dockerDaemon(session.sandbox);

    try {
        return await session.sandbox.attachWith('/bin/bash', b => b
            .args(bashArgs)
            .user('seu')
            .cwd(WORK_DIR)
            .envs(secrets)
        );
    } finally {
        // Explicit, rather than left to process exit: the handle IS the daemon's
        // supervisor, and a shell that has ended should not leave one behind
        // for the few seconds it takes this process to go away.
        await dockerd?.kill().catch(() => {});
    }
}

/**
 * A session without Docker is still worth a shell: report it, do not die.
 */
async function dockerDaemon(sandbox: Sandbox): Promise<ExecHandle | undefined> {
    try {
        return await startDockerd(sandbox);
    } catch (err) {
        LOG.warn(`dockerd is not available in this session: ${(err as Error).message}`);
        return undefined;
    }
}
