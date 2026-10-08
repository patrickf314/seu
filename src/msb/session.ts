import type { Sandbox, SandboxStatus } from 'microsandbox';
import { LOG } from '../common/log.ts';
import { die } from '../common/error.ts';
import { type Instance, seuCommand } from '../config/project.ts';
import { bootstrapVolume, connectToSandbox, removeSandbox, sandboxStatus, startSandbox } from './sandbox.ts';

const SESSION_SANDBOX_PREFIX = 'seu-session-';

export interface Session {
    /**
     * The session sandbox's name
     */
    readonly name: string;

    /**
     * The Micro sandbox
     */
    readonly sandbox: Sandbox;

    /**
     * True when this call had to start a sandbox that was merely stopped.
     */
    readonly resumed: boolean;
}

/**
 * The long-lived sandbox a developer works in. One per SEU instance.
 */
export function sessionSandboxName(instance: Instance): string {
    return `${SESSION_SANDBOX_PREFIX}${instance.name}`;
}

/**
 * The instance name a session sandbox belongs to, or undefined when the
 * sandbox is not a session.
 */
export function sessionInstanceName(sandboxName: string): string | undefined {
    return sandboxName.startsWith(SESSION_SANDBOX_PREFIX) ? sandboxName.slice(SESSION_SANDBOX_PREFIX.length) : undefined;
}

export async function sessionStatus(instance: Instance): Promise<SandboxStatus | 'absent'> {
    return sandboxStatus(sessionSandboxName(instance));
}

/**
 * Connect to the instance's session sandbox, starting it first if it is only
 * stopped. An absent session is the only refusal: making one is `seu start`'s
 * job, not something any other command should trigger behind your back.
 */
export async function resumeSession(instance: Instance): Promise<Session> {
    const name = sessionSandboxName(instance);
    const status = await sandboxStatus(name);
    if (status === 'absent') {
        die(`No session ${instance.name} (${name}) exists -- run \`${seuCommand(instance, 'start')}\` first`);
    }

    if (status === 'running') {
        return { name, sandbox: await connectToSandbox(name), resumed: false };
    }

    LOG.debug(`Starting session ${instance.name} (${name})`);
    const sandbox = await startSandbox(name);
    await bootstrapVolume(sandbox);
    return { name, sandbox, resumed: true };
}

export async function clearSession(instance: Instance): Promise<void> {
    await removeSandbox(sessionSandboxName(instance));
}
