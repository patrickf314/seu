// The `seu stop` flow: the session down, the volume untouched.
//
// Kept apart from the command const in src/cmd/stop.ts so that loading the
// command set does not load the microsandbox SDK.

import { LOG } from '../../common/log.ts';
import { die } from '../../common/error.ts';
import { resolveInstance, resolveProject, seuCommand, takeInstanceName } from '../../config/project.ts';
import { listForwards, stopAllForwards } from '../../network/forward.ts';
import { sandboxStatus, sessionSandboxName, stopSandbox } from '../../sandbox.ts';

export async function run(argv: string[]): Promise<void> {
    const { name, rest } = takeInstanceName(argv);
    for (const arg of rest) die(arg.startsWith('-') ? `unknown option for stop: ${arg}` : `stop takes one name, not ${arg}`);

    const instance = resolveInstance(await resolveProject(), name);
    const sandbox = sessionSandboxName(instance);
    const status = await sandboxStatus(sandbox);

    if (status === 'absent') die(`${sandbox} does not exist -- nothing to stop`);

    if (status === 'stopped' || status === 'crashed' || status === 'created') {
        LOG.step(`${sandbox} is not running (${status})`);
    } else {
        LOG.step(`Stopping ${sandbox}`);
        await stopSandbox(sandbox);
        LOG.ok('stopped');
    }

    // Also on a sandbox that was already down: that is exactly when stale
    // forward records are left behind.
    const forwards = listForwards(instance);
    stopAllForwards(instance);
    for (const f of forwards) LOG.ok(`dropped forward ${f.bind}:${f.host} -> vm:${f.guest}`);

    LOG.info(`/work and every cache are kept in the volume -- \`${seuCommand(instance, 'start')}\` resumes it`);
}
