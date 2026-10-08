import type { SeuConfig } from '../config/config.ts';
import type { Session } from './session.ts';
import { resolveSecrets } from '../config/secrets.ts';
import { WORK_DIR } from './sandbox.ts';

/**
 * Give the session a Docker daemon and the profile's secrets, and hand the
 * terminal over, until the shell ends. Also how `seu start` finishes.
 */
export async function shell(config: SeuConfig, session: Session): Promise<number> {
    const secrets = await resolveSecrets(config);
    return await session.sandbox.attachWith('/bin/bash', b => b
        .args(['--login'])
        .user('seu')
        .cwd(WORK_DIR)
        .envs(secrets)
    );
}
