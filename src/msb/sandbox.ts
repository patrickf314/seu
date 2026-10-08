// Guest-side plumbing shared by every seu command: the volume layout, bounded
// execs, and dockerd. Port of the sandbox half of lib/common.sh, on top of the
// microsandbox SDK instead of the `msb` CLI.

import type { ExecHandle, NetworkPolicyBuilder, Sandbox, SandboxHandle, SandboxStatus } from 'microsandbox';
import { sdk } from './sdk.ts';
import { sleep } from '../common/utils.ts';
import { LOG } from '../common/log.ts';
import { die } from '../common/error.ts';
import type { Project } from '../config/project.ts';
import type { Resources } from '../config/config.ts';
import { execInSandbox } from './exec.ts';
import { HOST_REPOSITORY_MOUNT, SRC_MOUNT, VOLUME_MOUNT, WORK_DIR } from '../common/constants.ts';

type NetworkBuilder = InstanceType<typeof import('microsandbox').NetworkBuilder>;
type TlsBuilder = InstanceType<typeof import('microsandbox').TlsBuilder>;

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
    readonly resources: Resources;
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
    const { project, resources } = spec;

    const builder = Sandbox.builder(spec.name)
        .image(spec.image)
        .pullPolicy('never')
        .replace()
        .detached(spec.detached)
        .cpus(resources.cpus)
        .memory(resources.memoryMiB)
        .rootDisk(resources.rootDiskMiB)
        .idleTimeout(resources.idleTimeoutSecs)
        .user('seu')
        .shell('/bin/bash')
        .network((n: NetworkBuilder) => {
            n.strict(spec.network.strict).policy(spec.network.policy);
            if (spec.network.strict) {
                n.tls((t: TlsBuilder) => t.verifyUpstream(true));
            }
            return n;
        })
        .volume(VOLUME_MOUNT, (m) => m.namedWith(spec.volume, 'ensure-exists', 'disk', resources.volumeSizeMiB))
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
 * Set up the home volume, then clone /src into ~/work, carrying over
 * uncommitted changes. Both scripts are idempotent and leave a populated home
 * and ~/work alone, so the install sandbox and the session can both call this.
 *
 * The home has to be set up first, as root: the volume mounts empty and
 * root-owned the first time (see vm/seu-home-init.sh).
 *
 * A problem with ~/work is reported, not fatal: an empty ~/work is worth a
 * session you can still get a shell in and look around.
 */
export async function prepareWork(sandbox: Sandbox): Promise<void> {
    const home = await execInSandbox(sandbox, {
        cmd: '/usr/local/bin/seu-home-init.sh',
        root: true,
        timeoutMs: 5 * 60_000,
    });
    if (!home.ok) {
        die(`could not set up ${VOLUME_MOUNT}: ${(home.stderr || home.stdout).trim()}`);
    }

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

/**
 * Start dockerd in the foreground of a streaming exec (see vm/dockerd-run.sh)
 * and wait until it answers. The returned handle IS the daemon's supervisor:
 * kill it and dockerd goes with it. Undefined when one is already running.
 *
 * dockerd occasionally loses its own startup race on a cold VM, hence the
 * retries.
 */
export async function startDockerd(sandbox: Sandbox): Promise<ExecHandle | undefined> {
    if (await dockerdRunning(sandbox)) {
        LOG.debug('dockerd already running');
        return undefined;
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
        const handle = await sandbox.execStreamWith('/usr/local/bin/dockerd-run.sh', b => b.user('root'));
        // Drain the stream so the guest is never blocked on a full pipe; the log
        // itself lives in /var/log/dockerd.log inside the VM.
        void (async () => {
            try {
                for await (const _event of handle) void _event;
            } catch {
                /* the handle was killed at teardown */
            }
        })();

        for (let i = 0; i < 30; i++) {
            if (await dockerdRunning(sandbox)) {
                LOG.ok('dockerd ready');
                return handle;
            }
            await sleep(2000);
        }

        await handle.kill().catch(() => {});
        if (attempt < 3) LOG.warn(`dockerd did not come up (attempt ${attempt}/3); retrying`);
    }

    LOG.warn('dockerd failed to start after 3 attempts');
    const log = await execInSandbox(sandbox, {
        cmd: 'sh',
        args: ['-c', 'tail -20 /var/log/dockerd.log'],
        root: true,
        timeoutMs: 20_000,
    });
    for (const line of log.stdout.trim().split('\n')) LOG.warn(`    ${line}`);
    return die('dockerd failed to start');
}

async function dockerdRunning(sandbox: Sandbox): Promise<boolean> {
    const probe = await execInSandbox(sandbox, {
        cmd: 'sh',
        args: ['-c', 'docker info >/dev/null 2>&1'],
        root: true,
        timeoutMs: 20_000,
    });
    return probe.ok;
}
