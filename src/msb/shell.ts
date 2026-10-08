import type { SeuConfig } from '../config/config.ts';
import type { Session } from './session.ts';
import { resolveSecrets } from '../config/secrets.ts';
import { WORK_DIR } from '../common/constants.ts';

/**
 * Give the session a Docker daemon and the profile's secrets, and hand the
 * terminal over, until the shell ends. Also how `seu start` finishes.
 */
export async function shell(config: SeuConfig, session: Session): Promise<number> {
    return attachLoginShell(config, session, ['--login']);
}

/**
 * Like {@link shell}, but the login shell execs straight into `claude`, with
 * permission prompts off -- the VM is the boundary they would otherwise be.
 * `args` are passed on to claude as they are, never as shell syntax.
 */
export async function claude(config: SeuConfig, session: Session, args: readonly string[]): Promise<number> {
    return attachLoginShell(config, session, [
        '--login', '-c', 'exec claude --dangerously-skip-permissions "$@"', 'claude', ...args,
    ]);
}

async function attachLoginShell(config: SeuConfig, session: Session, bashArgs: string[]): Promise<number> {
    const secrets = await resolveSecrets(config);
    return await session.sandbox.attachWith('/bin/bash', b => b
        .args(bashArgs)
        .user('seu')
        .cwd(WORK_DIR)
        .envs(secrets)
    );
}
