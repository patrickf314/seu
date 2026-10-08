import type { Sandbox, SandboxStatus } from 'microsandbox';
import { LOG } from '../common/log.ts';
import { die } from '../common/error.ts';
import type { SeuConfig } from '../config/config.ts';
import { type Instance, seuCommand } from '../config/project.ts';
import { sessionNetworkPolicy } from '../network/net.ts';
import {
    connectToSandbox,
    createSandbox,
    installSandboxName,
    prepareWork,
    removeSandbox,
    sandboxReady,
    sandboxStatus,
    startSandbox,
} from './sandbox.ts';
import type { Template } from './template.ts';
import { cloneVolume, removeVolume, volumeExists, volumeName } from './volume.ts';

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
    return { name, sandbox: await startSandbox(name), resumed: true };
}

export async function clearSession(instance: Instance): Promise<void> {
    await removeSandbox(sessionSandboxName(instance));
}

export async function sessionVolumeExists(instance: Instance): Promise<boolean> {
    return volumeExists(volumeName(instance.name));
}

/**
 * Whether there is anything of this SEU left: its session or its volume.
 */
export async function sessionExists(instance: Instance): Promise<boolean> {
    return (await sessionStatus(instance)) !== 'absent' || (await sessionVolumeExists(instance));
}

/**
 * The SEU's volume as a clone of the template's.
 */
export async function cloneSessionVolume(instance: Instance, template: Template): Promise<void> {
    const volume = volumeName(instance.name);
    const started = Date.now();
    await cloneVolume(template.volume, volume);
    LOG.ok(`${volume} (${Date.now() - started} ms)`);
}

/**
 * The session sandbox itself: the SEU's volume, the image, the narrowed policy,
 * and a lifetime of its own -- it is detached, so it stays up when the command
 * creating it returns.
 */
export async function createSession(instance: Instance, config: SeuConfig): Promise<Session> {
    const name = sessionSandboxName(instance);
    const sandbox = await createSandbox({
        name,
        image: config.image,
        project: instance.project,
        volume: volumeName(instance.name),
        network: { policy: await sessionNetworkPolicy(), strict: true },
        detached: true,
    });

    await sandboxReady(sandbox);
    LOG.ok(`${name} is running with the session network policy`);
    return { name, sandbox, resumed: false };
}

/**
 * The seu home and ~/work of the session. Idempotent.
 */
export async function prepareSessionWork(session: Session): Promise<void> {
    await prepareWork(session.sandbox);
}

/**
 * The SEU's session, any leftover install sandbox and its volume.
 */
export async function discardSession(instance: Instance): Promise<void> {
    const session = sessionSandboxName(instance);
    const volume = volumeName(instance.name);

    await removeSandbox(installSandboxName(instance));
    await clearSession(instance);
    await removeVolume(volume);
    LOG.ok(`removed ${session} and ${volume}`);
}
