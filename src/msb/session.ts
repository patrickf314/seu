import type { Sandbox, SandboxStatus } from 'microsandbox';
import { LOG } from '../common/log.ts';
import { die } from '../common/error.ts';
import { type Instance, seuCommand } from '../config/project.ts';
import { connectToSandbox, removeSandbox, sandboxStatus, startSandbox } from './sandbox.ts';

const SESSION_SANDBOX_PREFIX = 'seu-session-';

export interface Session {
    /**
     * The instance name
     */
    readonly name: string;

    /**
     * The Micro sandbox
     */
    readonly sandbox: Sandbox;
}

export async function sessionStatus(instance: Instance): Promise<SandboxStatus | 'absent'> {
    const sandboxName = sessionSandboxName(instance);
    return sandboxStatus(sandboxName);
}

export async function resumeSession(instance: Instance): Promise<Sandbox> {
    const sandboxName = sessionSandboxName(instance);
    const status = await sandboxStatus(sandboxName);
    if (status === 'absent') {
        die(`No session ${instance.name} (${sandboxName}) exists -- run \`${seuCommand(instance, 'start')}\` first`);
    }

    if (status === 'running') {
        return connectToSandbox(sandboxName);
    } else {
        return startSession(instance);
    }
}

export async function startSession(instance: Instance): Promise<Sandbox> {
    const sandboxName = sessionSandboxName(instance);
    LOG.debug(`Starting session ${instance.name} (${sandboxName})`);
    return await startSandbox(sessionSandboxName(instance));
}

export function isSessionSandbox(sandbox: Sandbox): boolean {
    return sandbox.name.startsWith(SESSION_SANDBOX_PREFIX);
}

export async function clearSession(instance: Instance): Promise<void> {
    const sandboxName = sessionSandboxName(instance);
    await removeSandbox(sandboxName);
}

function sessionSandboxName(instance: Instance): string {
    return `${SESSION_SANDBOX_PREFIX}${instance.name}`;
}
