import type { Sandbox, SandboxHandle, SandboxStatus } from 'microsandbox';
import { LOG } from '../common/log.ts';
import { die } from '../common/error.ts';
import type { SeuConfig } from '../config/config.ts';
import { type Instance, seuCommand } from '../config/project.ts';
import { sessionNetworkPolicy } from '../network/net.ts';
import {
    connectToSandbox,
    createSandbox,
    listSandboxes,
    prepareWork,
    removeSandbox,
    sandboxReady,
    sandboxStatus,
    startSandbox,
    stopSandbox,
} from './sandbox.ts';
import type { Template } from './template.ts';
import { SRC_MOUNT } from '../common/constants.ts';
import { cloneVolume, removeVolume, volumeExists } from './volume.ts';

const SESSION_SANDBOX_PREFIX = 'seu-session-';
const INSTALL_SANDBOX_PREFIX = 'seu-install-';

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
 * The install sandbox an older `seu start` used per SEU. Installs now only
 * ever happen into a template, but one of these can still be left over.
 */
export function installSandboxName(instance: Instance): string {
    return `${INSTALL_SANDBOX_PREFIX}${instance.name}`;
}

/**
 * The named volume of one SEU instance: ~/work, ~/.m2, ~/.cache, Docker images.
 */
export function sessionVolumeName(instance: Instance): string {
    return `seu-${instance.name}-data`;
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

export async function installSandboxStatus(instance: Instance): Promise<SandboxStatus | 'absent'> {
    return sandboxStatus(installSandboxName(instance));
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

export async function stopSession(instance: Instance): Promise<void> {
    await stopSandbox(sessionSandboxName(instance));
}

export async function clearSession(instance: Instance): Promise<void> {
    await removeSandbox(sessionSandboxName(instance));
}

export async function removeInstallSandbox(instance: Instance): Promise<void> {
    await removeSandbox(installSandboxName(instance));
}

/**
 * Remove the SEU's volume. False when there was none.
 */
export async function removeSessionVolume(instance: Instance): Promise<boolean> {
    return removeVolume(sessionVolumeName(instance));
}

export async function sessionVolumeExists(instance: Instance): Promise<boolean> {
    return volumeExists(sessionVolumeName(instance));
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
export async function cloneSessionVolume(instance: Instance, config: SeuConfig, template: Template): Promise<void> {
    const volume = sessionVolumeName(instance);
    const started = Date.now();
    await cloneVolume(template.volume, volume, config.resources.volumeSizeMiB);
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
        volume: sessionVolumeName(instance),
        network: { policy: await sessionNetworkPolicy(), strict: true },
        resources: config.resources,
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
    await removeInstallSandbox(instance);
    await clearSession(instance);
    await removeSessionVolume(instance);
    LOG.ok(`removed ${sessionSandboxName(instance)} and ${sessionVolumeName(instance)}`);
}

/**
 * A SEU's sandbox as read back from microsandbox: its session, or a leftover
 * install sandbox.
 */
export interface SessionListing {
    readonly instanceName: string;

    /**
     * True for a leftover install sandbox rather than the session.
     */
    readonly installing: boolean;

    readonly status: SandboxStatus;

    /**
     * The image it runs, from its stored config.
     */
    readonly image: string | undefined;

    /**
     * The worktree it mounts at /src.
     */
    readonly worktree: string;
}

/** The slice of a sandbox's stored config a listing reads. */
interface StoredConfig {
    image?: { Oci?: { reference?: string } };
    mounts?: { type?: string; host?: string; guest?: string }[];
}

/**
 * Every SEU's sandbox on this machine. There is no registry of SEUs to go
 * stale: the name says which SEU a sandbox is, its stored config which
 * worktree it mounts and which image it runs.
 */
export async function listSessions(): Promise<SessionListing[]> {
    return (await listSandboxes())
        .map(toListing)
        .filter((listing): listing is SessionListing => listing !== undefined);
}

function toListing(sandbox: SandboxHandle): SessionListing | undefined {
    const session = sessionInstanceName(sandbox.name);
    const install = sandbox.name.startsWith(INSTALL_SANDBOX_PREFIX)
        ? sandbox.name.slice(INSTALL_SANDBOX_PREFIX.length)
        : undefined;
    // Template install sandboxes and anything else that is not a SEU.
    const instanceName = session ?? install;
    if (instanceName === undefined) return undefined;

    let config: StoredConfig = {};
    try {
        config = JSON.parse(sandbox.configJson) as StoredConfig;
    } catch {
        // A sandbox whose config cannot be read is still worth a line.
    }

    const worktree = config.mounts?.find((m) => m.type === 'Bind' && m.guest === SRC_MOUNT)?.host;
    // Anything named like a SEU but not mounting a worktree at /src is not one.
    if (worktree === undefined) return undefined;

    return {
        instanceName,
        installing: install !== undefined,
        status: sandbox.status,
        image: config.image?.Oci?.reference,
        worktree,
    };
}
