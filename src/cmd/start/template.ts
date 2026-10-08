// The template: one installed volume per project, which every new SEU starts
// as a copy of.
//
// Installing is the expensive part of a SEU -- pulling the Docker images,
// resolving the Maven world, the first full build -- and it produces the same
// volume for every SEU of a project. So it happens once, into a volume of its
// own, and a new SEU's volume is an APFS clone of that: milliseconds, and no
// disk space until the two diverge.
//
// The template is keyed by the worktree's directory name, so worktrees that
// share one -- the same checkout under different SEU names -- share it.
//
// Building it is the old install step unchanged: a throwaway sandbox with wide
// egress over the template volume, which is destroyed before anything clones
// the volume -- so a clone never sees it mounted.

import type { ExecHandle } from 'microsandbox';
import type { SeuConfig } from '../../config/config.ts';
import { type Project, STATE_ROOT } from '../../config/project.ts';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LOG } from '../../common/log.ts';
import { sleep } from '../../host.ts';
import { buildNetworkPolicy } from '../../network/net.ts';
import { declareHostRepository, hostRepository, sealForOffline } from '../../maven/hostRepository.ts';
import { needsDocker, runInstall } from './install.ts';
import { toolchainFingerprint } from './toolchain.ts';
import {
    bootstrapVolume,
    createProjectSandbox,
    createVolume,
    destroySandbox,
    prepareWork,
    removeSandbox,
    removeVolume,
    startDockerd,
    TEMPLATE_PREFIX,
    volumeLabels,
    waitForAgent,
    WORK_DIR,
} from '../../sandbox.ts';

/** Volume labels: what a template was built from, for `seu list` and staleness. */
export const LABEL_IMAGE = 'seu.image';
export const LABEL_WORKTREE = 'seu.worktree';
export const LABEL_TOOLCHAIN = 'seu.toolchain';

export interface Template {
    /** The template volume. */
    readonly volume: string;
    /** The image it was installed with, from its label. */
    readonly image: string | undefined;
    /** The worktree whose install produced it, from its label. */
    readonly worktree: string | undefined;
    /** The mise.toml it was installed with, as `toolchainFingerprint`. */
    readonly toolchain: string | undefined;
}

/** `seu-template-<worktree directory name>`. */
export const templateVolumeName = (config: SeuConfig): string => `${TEMPLATE_PREFIX}${config.template}`;

/** Its throwaway install sandbox, while it is being built. */
const templateInstallSandboxName = (volume: string): string => `${volume}-install`;

/** The project's template, or undefined when there is none yet. */
export async function findTemplate(config: SeuConfig): Promise<Template | undefined> {
    const volume = templateVolumeName(config);
    const labels = await volumeLabels(volume);
    if (labels === undefined) return undefined;
    return {
        volume,
        image: labels[LABEL_IMAGE],
        worktree: labels[LABEL_WORKTREE],
        toolchain: labels[LABEL_TOOLCHAIN],
    };
}

/**
 * The project's template: the existing one, or one built from this worktree
 * when there is none -- or always, with `rebuild`.
 *
 * Under a lock, because two `seu start`s that both find no template would
 * otherwise both build it -- and each build begins by removing "the old"
 * install sandbox and volume, which are the other one's. The second start
 * waits instead, and then takes what the first one built; only a rebuild that
 * was asked for explicitly builds again after waiting.
 */
export async function obtainTemplate(
    image: string,
    project: Project,
    config: SeuConfig,
    opts: { rebuild: boolean; hostM2: boolean },
): Promise<{ template: Template; built: boolean }> {
    const volume = templateVolumeName(config);
    const release = await lockTemplate(volume);
    try {
        const existing = opts.rebuild ? undefined : await findTemplate(config);
        if (existing !== undefined) return { template: existing, built: false };
        return { template: await buildTemplate(image, project, config, opts.hostM2), built: true };
    } finally {
        release();
    }
}

/**
 * A lock file holding the owner's pid, created exclusively. One whose owner is
 * gone -- killed with -9, a crashed node -- is stale and taken over, so a lock
 * never outlives the process that took it by more than one check.
 */
async function lockTemplate(volume: string): Promise<() => void> {
    const dir = join(STATE_ROOT, 'locks');
    const file = join(dir, `${volume}.lock`);
    mkdirSync(dir, { recursive: true });

    let announced = false;
    for (;;) {
        try {
            writeFileSync(file, String(process.pid), { flag: 'wx' });
            break;
        } catch {
            const owner = Number(readFileSync(file, 'utf8').trim());
            if (!Number.isInteger(owner) || !alive(owner)) {
                rmSync(file, { force: true });
                continue;
            }
            if (!announced) {
                LOG.step(`Waiting for ${volume}`);
                LOG.info(`another \`seu start\` (pid ${owner}) is building it; this one uses the result`);
                announced = true;
            }
            await sleep(5000);
        }
    }

    // Also on process.exit -- the signal handlers end the process that way --
    // where a finally block never runs.
    const release = (): void => {
        process.removeListener('exit', release);
        if (existsSync(file) && readFileSync(file, 'utf8').trim() === String(process.pid)) rmSync(file, { force: true });
    };
    process.once('exit', release);
    return release;
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/**
 * (Re)build the project's template from this worktree: the `install` steps,
 * into a fresh volume. Only ever under the template lock.
 *
 * The old template is removed first -- clones of it are independent copies, so
 * no SEU depends on it. A build that fails or is interrupted removes its own
 * half-built volume, so the next start never clones a broken template.
 */
async function buildTemplate(image: string, project: Project, config: SeuConfig, hostM2: boolean): Promise<Template> {
    const volume = templateVolumeName(config);
    const sandboxName = templateInstallSandboxName(volume);

    LOG.step(`Building the template ${volume}`);
    LOG.debug(`installed once from ${project.root}; every new SEU of this project starts as a copy of it`);
    await removeSandbox(sandboxName);
    if (await removeVolume(volume)) LOG.ok(`removed the previous ${volume}`);
    const toolchain = toolchainFingerprint(config);
    await createVolume(volume, { [LABEL_IMAGE]: image, [LABEL_WORKTREE]: project.root, [LABEL_TOOLCHAIN]: toolchain });

    const discard = async (): Promise<void> => {
        await removeVolume(volume).catch(() => false);
        LOG.warn(`removed the incomplete template ${volume}`);
    };

    try {
        await install(image, project, config, volume, sandboxName, hostM2, discard);
    } catch (err) {
        await discard();
        throw err;
    }

    LOG.ok(`template ${volume} ready`);
    return { volume, image, worktree: project.root, toolchain };
}

/**
 * Installs the dependencies listed in the seu config
 */
async function install(
    image: string,
    project: Project,
    config: SeuConfig,
    volume: string,
    sandboxName: string,
    hostM2Wanted: boolean,
    onAbort: () => Promise<void>,
): Promise<void> {
    const steps = config.install;

    LOG.step('Host Maven repository');
    const hostM2 = hostRepository(hostM2Wanted);

    LOG.step('Creating the install sandbox (wide network egress)');
    const sandbox = await createProjectSandbox({
        name: sandboxName,
        image,
        project,
        volume,
        network: { policy: await buildNetworkPolicy(), strict: false },
        hostRepository: hostM2,
        // Throwaway: it must not outlive this command, and the teardown below
        // is what guarantees the volume is free to be cloned afterwards.
        detached: false,
    });
    LOG.ok('Created VM for install phase');

    let dockerd: ExecHandle | undefined = undefined;
    let failed = false;
    const teardown = async (): Promise<void> => {
        await dockerd?.kill().catch(() => {});
        dockerd = undefined;

        if (failed) keepLogs(sandboxName);
        await destroySandbox(sandbox);
        LOG.ok('Removed VM of install phase');
    };

    const onSignal = (): void => {
        void teardown()
            .then(onAbort)
            .finally(() => process.exit(130));
    };

    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    try {
        await waitForAgent(sandbox);
        await bootstrapVolume(sandbox);

        if (hostM2 !== undefined) await declareHostRepository(sandbox);

        // Always: the template's /work is what every SEU's /work starts from.
        LOG.step(`Preparing ${WORK_DIR}`);
        await prepareWork(sandbox);

        // dockerd is the slow part of the boot, so only a profile that needs
        // it gets it.
        if (needsDocker(steps)) {
            LOG.step('Starting dockerd in the install sandbox');
            dockerd = await startDockerd(sandbox);
        }

        if (steps.length === 0) {
            LOG.debug('no install steps');
        } else {
            await runInstall(sandbox, steps);
        }

        // Before the sandbox -- and with it /host-m2 -- goes away. What was just
        // resolved is unusable offline until its origin is forgotten.
        if (hostM2 !== undefined) {
            LOG.step('Handing the repository over');
            await sealForOffline(sandbox);
        }
    } catch (err) {
        failed = true;
        throw err;
    } finally {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        await teardown();
    }
}

/**
 * microsandbox keeps a sandbox's kernel, runtime and exec logs in its own
 * directory, which goes when the sandbox is destroyed. A failed install is
 * exactly when they matter -- a VM that dies mid-pull says why in kernel.log
 * and nowhere else -- so they are copied out first.
 */
function keepLogs(sandboxName: string): void {
    const home = process.env['MSB_HOME'] ?? join(homedir(), '.microsandbox');
    const logs = join(home, 'sandboxes', sandboxName, 'logs');
    if (!existsSync(logs)) return;

    const target = join(STATE_ROOT, 'failed-installs', `${sandboxName}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    try {
        cpSync(logs, target, { recursive: true });
        LOG.info(`the install sandbox's logs are kept in ${target}`);
    } catch {
        // Diagnostics only; never the reason a failure report goes missing.
    }
}
