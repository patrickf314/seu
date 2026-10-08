// Guest-side plumbing shared by every seu command: the volume layout, bounded
// execs, and dockerd. Port of the sandbox half of lib/common.sh, on top of the
// microsandbox SDK instead of the `msb` CLI.

import type { NetworkPolicyBuilder, Sandbox, SandboxHandle, SandboxStatus } from 'microsandbox';
import { sdk } from './sdk.ts';
import { sleep } from '../common/utils.ts';
import { LOG } from '../common/log.ts';
import { die } from '../common/error.ts';
import type { Instance, Project } from '../config/project.ts';
import { execInSandbox } from './exec.ts';
import { VOLUME_SIZE_MIB } from './volume.ts';

type NetworkBuilder = InstanceType<typeof import('microsandbox').NetworkBuilder>;
type TlsBuilder = InstanceType<typeof import('microsandbox').TlsBuilder>;

export const RESOURCES = {
    cpus: 4,
    memoryMiB: 10 * 1024,
    rootDiskMiB: 20 * 1024,
    idleTimeoutSecs: 60 * 60,
};

const HOME_DIR = '/home/seu';

export const VOLUME_MOUNT = HOME_DIR;

/**
 * The worktree, mounted read-only. Nothing in here is ever written to.
 */
export const SRC_MOUNT = '/src';

/** The writable clone of /src, living in the named volume. */
export const WORK_DIR = HOME_DIR + '/work';

/**
 * The host's own Maven repository, read-only. Install sandbox only.
 */
export const HOST_REPOSITORY_MOUNT = '/host-m2';

/**
 * The install sandbox an older `seu start` used per SEU. Installs now only
 * ever happen into a template, but one of these can still be left over.
 */
export const installSandboxName = (instance: Instance): string => `seu-install-${instance.name}`;

/**
 * Creates the directory layout inside the named volume. Must run before
 * anything resolves /work, ~/.m2 or ~/.cache: those are symlinks into /seu, and
 * the volume mounts empty the first time. This is also why no sandbox is
 * created with a /work workdir -- the image's workdir is validated at create
 * time, when the symlink still dangles.
 */
export async function bootstrapVolume(sandbox: Sandbox): Promise<void> {
    const out = await execInSandbox(sandbox, {
        cmd: 'sh',
        args: [
            '-c',
            'mkdir -p /seu/work /seu/m2 /seu/cache /seu/docker /seu/mise && chown seu:seu /seu /seu/work /seu/m2 /seu/cache /seu/mise',
        ],
        root: true,
        timeoutMs: 60_000,
    });
    if (!out.ok) {
        die('could not bootstrap the /seu volume layout');
    }
}

/**
 * Egress for one sandbox. Fixed at creation -- microsandbox has no way to
 * narrow a running sandbox's policy -- which is why the install sandbox and the
 * session are two different sandboxes over one shared volume.
 */
export interface NetworkSpec {
    readonly policy: NetworkPolicyBuilder;
    /**
     * Fail closed on anything the policy cannot inspect. It REQUIRES TLS
     * interception (which is also what stops a hostname allow from being
     * domain-fronted), so the two are turned on together below.
     *
     * Off for the template's install sandbox: interception would mean importing
     * the microsandbox CA into the JDK truststore, because the JVM ignores the OS
     * trust store and Maven would fail every HTTPS fetch. Those are controlled,
     * one-shot steps, so a plain hostname allowlist is the right trade there.
     */
    readonly strict: boolean;
}

export interface SandboxSpec {
    readonly name: string;
    /** Image reference, already loaded into microsandbox's image store. */
    readonly image: string;
    readonly project: Project;
    /** The named disk volume mounted at /seu. Created if it does not exist. */
    readonly volume: string;
    readonly network: NetworkSpec;
    /**
     * The developer's own ~/.m2/repository, mounted read-only at /host-m2 as a
     * resolution source. Install sandbox only; undefined for the session, which must not depend on a
     * host path it will not have.
     */
    readonly hostRepository?: string | undefined;
    /**
     * Outlive this process. True for the session, which has to still be there
     * when `seu start` returns; false for a throwaway sandbox, which must not.
     */
    readonly detached: boolean;
}

/**
 * The one definition of how a seu sandbox is mounted and resourced.
 */
export async function createSandbox(spec: SandboxSpec): Promise<Sandbox> {
    const { Sandbox } = await sdk();
    const { project } = spec;

    const builder = Sandbox.builder(spec.name)
        .image(spec.image)
        .pullPolicy('never')
        .replace()
        .detached(spec.detached)
        .cpus(RESOURCES.cpus)
        .memory(RESOURCES.memoryMiB)
        .rootDisk(RESOURCES.rootDiskMiB)
        .idleTimeout(RESOURCES.idleTimeoutSecs)
        .user('seu')
        .shell('/bin/bash')
        .network((n: NetworkBuilder) => {
            n.strict(spec.network.strict).policy(spec.network.policy);
            if (spec.network.strict) {
                n.tls((t: TlsBuilder) => t.verifyUpstream(true));
            }
            return n;
        })
        .volume(VOLUME_MOUNT, (m) => m.namedWith(spec.volume, 'ensure-exists', 'disk', VOLUME_SIZE_MIB))
        .volume(SRC_MOUNT, (m) => m.bind(project.root).readonly());

    const gitDir = project.gitDir;
    if (gitDir !== null) {
        builder.volume(gitDir, m => m.bind(gitDir).readonly());
    }

    if (spec.hostRepository !== undefined) {
        builder.volume(HOST_REPOSITORY_MOUNT, m => m.bind(spec.hostRepository).readonly());
    }

    return builder.create();
}

/**
 * Clone /src into /work, carrying over uncommitted changes. See
 * vm/session-init.sh; it is idempotent and leaves a populated /work alone, so
 * the install sandbox and the session can both call it.
 *
 * A problem here is reported, not fatal: an empty /work is worth a session you
 * can still get a shell in and look around.
 */
export async function prepareWork(sandbox: Sandbox): Promise<void> {
    const result = await execInSandbox(sandbox, {
        cmd: 'bash',
        args: ['-lc', '/usr/local/bin/session-init.sh'],
        timeoutMs: 15 * 60_000,
        stream: true,
    });
    if (result.ok) {
        LOG.ok(`${WORK_DIR} ready`);
    } else {
        LOG.warn(`session-init reported a problem; ${WORK_DIR} may be incomplete`);
    }
}

export async function sandboxStatus(name: string): Promise<SandboxStatus | 'absent'> {
    const handle = await sandboxHandle(name);
    if (handle === undefined) {
        return 'absent';
    } else {
        return handle.status;
    }
}

/**
 * Starts a detached sandbox
 */
export async function startSandbox(name: string): Promise<Sandbox> {
    const { Sandbox } = await sdk();
    try {
        const sandbox = await Sandbox.startDetached(name);
        await sandboxReady(sandbox);
        return sandbox;
    } catch (err) {
        return die(`could not start ${name}: ${(err as Error).message}`);
    }
}

/**
 * Connect to a running sandbox
 *
 * @param name the name of the sandbox
 */
export async function connectToSandbox(name: string): Promise<Sandbox> {
    const handle = await sandboxHandle(name);
    if (handle === undefined) {
        die(`could not connect to sandbox ${name}: sandbox does not exist`);
    }

    if (handle.status !== 'running') {
        die(`could not connect to sandbox ${name}: sandbox is not running`);
    }

    return handle.connect();
}

/**
 * Stop a running sandbox
 */
export async function stopSandbox(name: string): Promise<void> {
    const handle = await sandboxHandle(name);
    if (handle === undefined) {
        return;
    }

    try {
        await handle.stopWithTimeout(60_000);
    } catch {
        LOG.warn(`graceful stop of ${name} timed out; killing it`);
        await handle.kill().catch(() => {
        });
    }
}

/**
 * Stop a sandbox if it is running, then remove it
 */
export async function removeSandbox(name: string): Promise<void> {
    const handle = await sandboxHandle(name);
    if (handle === undefined) {
        return;
    }

    if (handle.status !== 'stopped' && handle.status !== 'crashed' && handle.status !== 'created') {
        await stopSandbox(name);
    }

    try {
        await handle.remove();
    } catch (err) {
        die(`could not remove ${name}: ${(err as Error).message}`);
    }
}

/**
 * Destroy a sandbox
 */
export async function destroySandbox(sandbox: Sandbox): Promise<void> {
    try {
        await sandbox.destroy({ timeoutMs: 10_000 });
    } catch {
        await sandbox.destroy({ force: true }).catch(() => {
        });
    }
}

/**
 * Lists all sandboxes
 */
export async function listSandboxes(): Promise<SandboxHandle[]> {
    const { Sandbox } = await sdk();

    const all: SandboxHandle[] = [];
    let cursor: string | undefined;
    do {
        const page = await Sandbox.listWith(l => (cursor === undefined ? l : l.cursor(cursor)));
        all.push(...page.sandboxes);
        cursor = page.nextCursor;
    } while (cursor !== undefined);

    return all;
}

async function sandboxHandle(name: string): Promise<SandboxHandle | undefined> {
    const { Sandbox } = await sdk();
    try {
        return await Sandbox.get(name);
    } catch {
        return undefined;
    }
}

export async function sandboxReady(sandbox: Sandbox): Promise<void> {
    for (let i = 0; i < 45; i++) {
        const probe = await execInSandbox(sandbox, { cmd: 'true', root: true, timeoutMs: 10_000 });
        if (probe.ok) {
            return;
        }

        await sleep(1000);
    }
    die(`${sandbox.name}: the guest agent never became ready`);
}
