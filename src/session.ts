// The session sandbox: the long-lived one `seu start` leaves behind, and the
// invariant everything after `start` depends on -- that it is running.
//
// `start` owns creating it. The commands here only ever find it, because making
// one means `install.script`, which is an hour on a cold reactor and nothing
// `seu shell` should trigger behind your back.

import type { Sandbox, SandboxStatus } from 'microsandbox';
import { sdk } from './microsandbox/microsandboxSdk.ts';
import { LOG } from './common/log.ts';
import { die } from './common/error.ts';
import { type Instance, seuCommand } from './config/project.ts';
import { bootstrapVolume, sandboxStatus, sessionSandboxName, startSandbox, waitForAgent } from './sandbox.ts';

export interface Session {
    readonly name: string;
    readonly sandbox: Sandbox;
    /** True when this call had to start a sandbox that was merely stopped. */
    readonly resumed: boolean;
}

/**
 * The session sandbox's status without connecting to it, for the one caller
 * -- `seu port`'s listing -- that has something to say about a stopped one.
 */
export async function sessionStatus(instance: Instance): Promise<SandboxStatus | 'absent'> {
    return sandboxStatus(sessionSandboxName(instance));
}

/**
 * Connect to the instance's session sandbox, starting it first if it is only
 * stopped.
 *
 * A stop costs nothing: /work, ~/.m2 and every cache live in the named volume,
 * and the sandbox keeps its root disk and its narrowed network policy. So a
 * resume is the right answer to "it is not running", and an absent sandbox --
 * which no amount of starting produces -- is the only refusal.
 */
export async function requireSession(instance: Instance): Promise<Session> {
    const name = sessionSandboxName(instance);
    const status = await sessionStatus(instance);

    if (status === 'absent') {
        die(`${name} does not exist -- run \`${seuCommand(instance, 'start')}\` first`);
    }

    if (status === 'running') {
        const { Sandbox } = await sdk();
        const handle = await Sandbox.get(name);
        // connect(), not start(): this process is a visitor. The session has to
        // outlive it, so it must not take the sandbox's lifecycle with it.
        return { name, sandbox: await handle.connect(), resumed: false };
    }

    LOG.step(`Starting ${name} (${status})`);
    const sandbox = await startSandbox(name);
    await waitForAgent(sandbox);
    await bootstrapVolume(sandbox);
    LOG.ok(`${name} is running`);

    return { name, sandbox, resumed: true };
}
