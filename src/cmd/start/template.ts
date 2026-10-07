// The template: one installed volume per project, which every new SEU starts
// as a copy of.
//
// Installing is the expensive part of a SEU -- pulling the Docker images,
// resolving the Maven world, the first full build -- and it produces the same
// volume for every SEU of a project. So it happens once, into a volume of its
// own, and a new SEU's volume is an APFS clone of that: milliseconds, and no
// disk space until the two diverge.
//
// The template is keyed by the image repository (`image.tag`, by default the
// directory name of the first worktree) rather than by worktree, so every
// worktree of a repository shares it: they share that tag already.
//
// Building it is the old install step unchanged: a throwaway sandbox with wide
// egress over the template volume, which is destroyed before anything clones
// the volume -- so a clone never sees it mounted.

import type { ExecHandle, Sandbox } from 'microsandbox';
import { CONFIG_FILE, type SeuConfig } from '../../config/config.ts';
import { type Project, STATE_ROOT } from '../../config/project.ts';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LOG } from '../../common/log.ts';
import { die } from '../../common/error.ts';
import { sleep } from '../../host.ts';
import { buildNetworkPolicy } from '../../network/net.ts';
import { declareHostRepository, hostRepository, sealForOffline } from '../../maven/hostRepository.ts';
import { runPreInstall } from './pre-install.ts';
import {
    bootstrapVolume,
    createProjectSandbox,
    createVolume,
    destroySandbox,
    exec,
    prepareWork,
    removeSandbox,
    removeVolume,
    startDockerd,
    TEMPLATE_PREFIX,
    volumeLabels,
    waitForAgent,
    WORK_DIR,
} from '../../sandbox.ts';

/**
 * A full `mvn clean install` on a large reactor is a long hour on a cold cache,
 * and the alternative to a generous budget is killing a build that would have
 * finished. The watchdog is only here so a wedged step cannot hang forever.
 */
const INSTALL_TIMEOUT_MS = 90 * 60_000;

/** Volume labels: what a template was built from, for `seu list` and staleness. */
export const LABEL_IMAGE = 'seu.image';
export const LABEL_WORKTREE = 'seu.worktree';

export interface Template {
    /** The template volume. */
    readonly volume: string;
    /** The image it was installed with, from its label. */
    readonly image: string | undefined;
    /** The worktree whose install produced it, from its label. */
    readonly worktree: string | undefined;
}

/** `seu-template-<image repository>`, with a `/` in the repository made a `-`. */
export const templateVolumeName = (config: SeuConfig): string =>
    `${TEMPLATE_PREFIX}${config.image.tag.replace(/[^A-Za-z0-9._-]/g, '-')}`;

/** Its throwaway install sandbox, while it is being built. */
const templateInstallSandboxName = (volume: string): string => `${volume}-install`;

/** The project's template, or undefined when there is none yet. */
export async function findTemplate(config: SeuConfig): Promise<Template | undefined> {
    const volume = templateVolumeName(config);
    const labels = await volumeLabels(volume);
    if (labels === undefined) return undefined;
    return { volume, image: labels[LABEL_IMAGE], worktree: labels[LABEL_WORKTREE] };
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
 * (Re)build the project's template from this worktree: pre-install, then
 * `install.script`, into a fresh volume. Only ever under the template lock.
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
    await createVolume(volume, { [LABEL_IMAGE]: image, [LABEL_WORKTREE]: project.root });

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
    return { volume, image, worktree: project.root };
}

/**
 * Pre-install and `install.script`, in one throwaway sandbox with build egress.
 *
 * Everything it writes goes into the volume -- /work, ~/.m2, ~/.cache and
 * /seu/docker are all in there -- so what it fetches is exactly what an offline
 * session gets. Anything it leaves outside /seu dies with this sandbox.
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
    const steps = config.image.preInstall;
    const script = config.install.script;

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

        // dockerd is the slow part of the boot. Pulling images needs it; the
        // script gets it unconditionally, because a build command is opaque to
        // us, and the ones that want Docker (Testcontainers, buildpacks, a
        // compose file started by a test) fail in ways that point anywhere but
        // at a missing daemon. Only a profile that just resolves Maven
        // artifacts goes without.
        if (script !== undefined || steps.some((s) => s.type === 'docker' || s.type === 'docker-compose')) {
            LOG.step('Starting dockerd in the install sandbox');
            dockerd = await startDockerd(sandbox);
        }

        if (steps.length > 0) {
            LOG.step('Pre-Install');
            await runPreInstall(sandbox, steps);
        }

        if (script === undefined) {
            LOG.debug(`no install.script in ${CONFIG_FILE}`);
        } else {
            await runInstallScript(sandbox, script);
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

async function runInstallScript(sandbox: Sandbox, script: string): Promise<void> {
    LOG.step('Running install.script');
    LOG.debug(`${WORK_DIR}$ ${script}`);
    warnOnRootWork(script);

    const result = await exec(sandbox, {
        // The script IS a shell command -- see InstallScript in
        // src/config/config.ts. It runs as `seu`, in a sandbox that is
        // destroyed right after, and never on the host.
        cmd: 'bash',
        args: ['-lc', script],
        user: 'seu',
        cwd: WORK_DIR,
        timeoutMs: INSTALL_TIMEOUT_MS,
        stream: true,
    });

    if (!result.ok) {
        die(
            result.timedOut
                ? `install.script did not finish within ${INSTALL_TIMEOUT_MS / 60_000} minutes`
                : `install.script failed (exit ${result.code})`,
        );
    }
    LOG.ok('install.script finished');
}

/**
 * The install runs as `seu`, in a sandbox whose rootfs is thrown away. A step
 * that wants root is therefore wrong twice over, and the way it announces
 * itself -- a sudo password prompt on a VM with no password -- says neither.
 *
 * A warning rather than a refusal: the script is the project's business, and a
 * `docker run` of something that happens to contain the word apt-get is nobody
 * else's. But it names the fix, which is the part that is hard to guess.
 */
function warnOnRootWork(script: string): void {
    const needsRoot = /\b(sudo|apt-get|apt-key|install-deps)\b/.exec(script);
    if (needsRoot === null) return;

    LOG.warn(`install.script contains \`${needsRoot[0]}\`, which wants root`);
    LOG.warn('    this runs as `seu`, and anything outside /seu dies with this sandbox');
    LOG.warn('    system packages belong in vm/Dockerfile -- they are baked into the base image');
}
