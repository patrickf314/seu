import type { ExecHandle, Sandbox } from 'microsandbox';
import type { InstallStep, SeuConfig } from '../config/config.ts';
import { CONFIG_FILE } from '../config/config.ts';
import { type Project, STATE_ROOT } from '../config/project.ts';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LOG } from '../common/log.ts';
import { die } from '../common/error.ts';
import { sleep } from '../common/utils.ts';
import { buildNetworkPolicy } from '../network/net.ts';
import { declareHostRepository, hostRepository, sealForOffline } from '../maven/settings.ts';
import {
    createSandbox,
    destroySandbox,
    prepareWork,
    removeSandbox,
    startDockerd,
} from './sandbox.ts';
import { SRC_MOUNT, VOLUME_MOUNT, WORK_DIR } from '../common/constants.ts';
import { execInSandbox } from './exec.ts';
import { sdk } from './sdk.ts';
import { createVolume, removeVolume, volumeLabels } from './volume.ts';

/**
 * Volume labels: what a template was built from, for `seu list` and staleness.
 */
const LABEL_IMAGE = 'seu.image';
const LABEL_WORKTREE = 'seu.worktree';
const LABEL_INSTALL = 'seu.install';

const TEMPLATE_PREFIX = 'seu-template-';

const COMPOSE_TIMEOUT_MS = 2 * 60_000; // 2min
const PULL_TIMEOUT_MS = 20 * 60_000; // 20min
const MAVEN_TIMEOUT_MS = 20 * 60_000; // 20min
const MISE_TIMEOUT_MS = 30 * 60_000; // 30min, a JDK download on a slow line, times a few tools
const SCRIPT_TIMEOUT_MS = 90 * 60_000; // 90min

interface InstallStepFingerprint {
    type: InstallStep['type'];
    fingerprint: string;
}

export interface Template {

    /**
     * The template volume.
     */
    readonly volume: string;

    /**
     * The image it was installed with, from its label.
     */
    readonly image: string | undefined;

    /**
     * The worktree whose install produced it, from its label.
     */
    readonly worktree: string | undefined;

    /**
     * Why it no longer matches the config, or undefined when it does.
     */
    readonly outdated: string | undefined;
}

/**
 * The project's template, or undefined when there is none yet. One that was
 * built from a different image or different install steps is still returned,
 * with `outdated` saying why.
 */
export async function findTemplate(project: Project, config: SeuConfig): Promise<Template | undefined> {
    const volumeName = templateVolumeName(config);
    const labels = await volumeLabels(volumeName);
    if (labels === undefined) {
        return undefined;
    }

    return {
        volume: volumeName,
        image: labels[LABEL_IMAGE],
        worktree: labels[LABEL_WORKTREE],
        outdated: outdatedBecause(project, config, labels),
    };
}

/**
 * Every project's template on this machine, for `seu list`. Whether one is
 * outdated is only known against its project's config, so it is not said here.
 */
export async function listTemplates(): Promise<Omit<Template, 'outdated'>[]> {
    const { Volume } = await sdk();
    const handles = await Volume.list();
    return handles
        .filter(handle => handle.name.startsWith(TEMPLATE_PREFIX))
        .map(handle => {
            const labels = Object.fromEntries(handle.labels);
            return { volume: handle.name, image: labels[LABEL_IMAGE], worktree: labels[LABEL_WORKTREE] };
        })
        .sort((a, b) => a.volume.localeCompare(b.volume));
}

/**
 * (Re)build the project's template from this worktree: the `install` steps,
 * into a fresh volume.
 *
 * The old template is removed first -- clones of it are independent copies, so
 * no SEU depends on it. A build that fails or is interrupted removes its own
 * half-built volume, so the next start never clones a broken template.
 *
 * Under a lock, because two `seu start`s that both found no template would
 * otherwise both build it -- and each build begins by removing "the old"
 * install sandbox and volume, which are the other one's. The second start
 * waits instead, and takes what the first one built when that is up to date.
 */
export async function buildTemplate(project: Project, config: SeuConfig, opts: { hostM2: boolean }): Promise<Template> {
    const volume = templateVolumeName(config);
    const lock = await lockTemplate(volume);
    try {
        if (lock.waited) {
            const built = await findTemplate(project, config);
            if (built !== undefined && built.outdated === undefined) {
                LOG.ok(`${volume} was just built by the other \`seu start\``);
                return built;
            }
        }
        return await build(project, config, opts.hostM2);
    } finally {
        lock.release();
    }
}

function templateVolumeName(config: SeuConfig): string {
    return `${TEMPLATE_PREFIX}${config.template}`;
}

function templateInstallSandboxName(config: SeuConfig): string {
    return `${templateVolumeName(config)}-install`;
}

function outdatedBecause(project: Project, config: SeuConfig, labels: Record<string, string>): string | undefined {
    const image = labels[LABEL_IMAGE];
    if (image !== config.image) {
        return `it was installed with ${image ?? 'an unknown image'}, the image is now ${config.image}`;
    }

    const installed = parseFingerprints(labels[LABEL_INSTALL]);
    if (installed === undefined) {
        return 'it carries no install fingerprints';
    }

    const wanted = installFingerprints(project, config);
    const same = installed.length === wanted.length
        && installed.every((s, i) => s.type === wanted[i].type && s.fingerprint === wanted[i].fingerprint);
    return same ? undefined : `the install steps in ${CONFIG_FILE} changed since it was built`;
}

function installFingerprints(project: Project, config: SeuConfig): InstallStepFingerprint[] {
    return config.install.map((step) => ({ type: step.type, fingerprint: stepFingerprint(project, step) }));
}

function stepFingerprint(project: Project, step: InstallStep): string {
    switch (step.type) {
        case 'docker':
            return step.image;
        case 'maven':
            return step.artifact;
        case 'docker-compose':
            return hash(readFileSync(join(project.root, step.compose.replace(/^\.\//, ''))));
        case 'mise':
            return hash(readFileSync(step.toml));
        case 'script':
            return hash(step.script);
    }
}

function hash(data: string | Buffer): string {
    return createHash('sha256').update(data).digest('hex').slice(0, 12);
}

/**
 * The install label, or undefined when it is missing or unreadable.
 */
function parseFingerprints(label: string | undefined): InstallStepFingerprint[] | undefined {
    if (label === undefined) {
        return undefined;
    }

    try {
        const parsed: unknown = JSON.parse(label);
        return Array.isArray(parsed) ? (parsed as InstallStepFingerprint[]) : undefined;
    } catch {
        return undefined;
    }
}

async function lockTemplate(volume: string): Promise<{ release: () => void; waited: boolean }> {
    const dir = join(STATE_ROOT, 'locks');
    const file = join(dir, `${volume}.lock`);
    mkdirSync(dir, { recursive: true });

    let announced = false;
    for (; ;) {
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
                LOG.info(`waiting for ${volume}: another \`seu start\` (pid ${owner}) is building it`);
                announced = true;
            }
            await sleep(5000);
        }
    }

    const release = (): void => {
        process.removeListener('exit', release);
        if (existsSync(file) && readFileSync(file, 'utf8').trim() === String(process.pid)) rmSync(file, { force: true });
    };

    process.once('exit', release);
    return { release, waited: announced };
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

async function build(project: Project, config: SeuConfig, hostM2: boolean): Promise<Template> {
    const volumeName = templateVolumeName(config);
    const sandboxName = templateInstallSandboxName(config);
    const image = config.image;

    LOG.debug(`installed once from ${project.root}; every new SEU of this project starts as a copy of it`);

    await removeSandbox(sandboxName);
    if (await removeVolume(volumeName)) {
        LOG.ok(`removed the previous ${volumeName}`);
    }

    await createVolume(volumeName, config.resources.volumeSizeMiB, {
        [LABEL_IMAGE]: image,
        [LABEL_WORKTREE]: project.root,
        [LABEL_INSTALL]: JSON.stringify(installFingerprints(project, config)),
    });

    const discard = async (): Promise<void> => {
        await removeVolume(volumeName).catch(() => false);
        LOG.warn(`removed the incomplete template ${volumeName}`);
    };

    try {
        await install(image, project, config, hostM2, discard);
    } catch (err) {
        await discard();
        throw err;
    }

    LOG.ok(`template ${volumeName} ready`);
    return { volume: volumeName, image, worktree: project.root, outdated: undefined };
}

async function install(
    image: string,
    project: Project,
    config: SeuConfig,
    hostM2Wanted: boolean,
    onAbort: () => Promise<void>,
): Promise<void> {
    const volumeName = templateVolumeName(config);
    const sandboxName = templateInstallSandboxName(config);
    const steps = config.install;
    const hostM2 = hostRepository(hostM2Wanted);

    LOG.info('creating the install sandbox (wide network egress)');
    const sandbox = await createSandbox({
        name: sandboxName,
        image,
        project,
        volume: volumeName,
        network: { policy: await buildNetworkPolicy(), strict: false },
        resources: config.resources,
        hostRepository: hostM2,
        // Throwaway: it must not outlive this command, and the teardown below
        // is what guarantees the volume is free to be cloned afterwards.
        detached: false,
    });
    LOG.ok('Created VM for install phase');

    let dockerd: ExecHandle | undefined = undefined;
    let failed = false;
    const teardown = async (): Promise<void> => {
        await dockerd?.kill().catch(() => {
        });
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
        // Always: the template's ~/work is what every SEU's ~/work starts from.
        LOG.info(`preparing ${WORK_DIR}`);
        await prepareWork(sandbox);

        if (hostM2 !== undefined) await declareHostRepository(sandbox);

        // dockerd is the slow part of the boot, so only a profile that needs
        // it gets it.
        if (needsDocker(steps)) {
            LOG.info('starting dockerd in the install sandbox');
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
            LOG.info('handing the Maven repository over');
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

/**
 * Run every step, in declaration order.
 *
 * Steps are NOT run in parallel: `mvn dependency:get` and `docker pull` both
 * write into the same volume, the order in the config is the order the author
 * reasoned about -- the mise step before anything that needs its JDK -- and a
 * serial log is the one that says which line is slow.
 *
 * A failed fetch does not stop the fetches after it, so one start reports all
 * of them; but they are settled before a mise or script step, which would
 * otherwise spend its time on a template that is already broken.
 */
function needsDocker(steps: readonly InstallStep[]): boolean {
    // A script gets it unconditionally, because a build command is opaque to
    // us, and the ones that want Docker (Testcontainers, buildpacks, a compose
    // file started by a test) fail in ways that point anywhere but at a
    // missing daemon.
    return steps.some(s => s.type === 'docker' || s.type === 'docker-compose' || s.type === 'script');
}

async function runInstall(sandbox: Sandbox, steps: readonly InstallStep[]): Promise<void> {
    // Across the whole run, not per step: two compose files naming the same
    // postgres is the normal case, and the second pull is pure wall-clock.
    const pulled = new Set<string>();
    const failures: string[] = [];

    for (const step of steps) {
        switch (step.type) {
            case 'docker-compose': {
                LOG.info(`pulling the images of ${step.compose}`);
                for (const image of await composeImages(sandbox, step.compose)) {
                    await pull(sandbox, image, pulled, failures);
                }
                break;
            }
            case 'docker': {
                LOG.info(`pulling ${step.image}`);
                await pull(sandbox, step.image, pulled, failures);
                break;
            }
            case 'maven': {
                LOG.info(`resolving ${step.artifact}`);
                await resolveArtifact(sandbox, step.artifact, failures);
                break;
            }
            case 'mise': {
                failOn(failures);
                await installToolchain(sandbox, step.toml);
                break;
            }
            case 'script': {
                failOn(failures);
                await runScript(sandbox, step.script);
                break;
            }
        }
    }

    failOn(failures);
}

function failOn(failures: readonly string[]): void {
    if (failures.length === 0) return;
    die(
        `${failures.length} install step(s) failed -- the session has no network, ` +
        `so anything missing now stays missing:\n    ${failures.join('\n    ')}`,
    );
}

/**
 * The images a compose file names, as compose itself resolves them --
 * variables substituted, `extends` followed, defaults filled in.
 *
 * The resolved model rather than `docker compose pull`, for two reasons: it
 * buys the per-image reporting below, and it is the only way to tell a service
 * that is PULLED from one that is BUILT. `--images` prints both, and the name
 * it invents for a built service (`<project>-<service>`) exists in no registry,
 * so pulling the list it prints fails on a perfectly correct compose file.
 */
async function composeImages(sandbox: Sandbox, file: string): Promise<string[]> {
    const result = await execInSandbox(sandbox, {
        cmd: 'bash',
        // `--profile '*'`: a service behind a profile is still a service
        // somebody will start one day, and the session has no second chance to
        // pull it. Compose would leave them out of the default model.
        args: ['-lc', 'docker compose --profile "*" -f "$SEU_COMPOSE_FILE" config --format json'],
        env: { SEU_COMPOSE_FILE: `${SRC_MOUNT}/${file}` },
        timeoutMs: COMPOSE_TIMEOUT_MS,
    });
    if (!result.ok) {
        const detail = (result.stderr || result.stdout).trim().split('\n').slice(-5).join('\n    ');
        die(`could not read the images out of ${file}\n    ${detail}`);
    }

    let model: { services?: Record<string, { image?: unknown; build?: unknown }> };
    try {
        model = JSON.parse(result.stdout) as typeof model;
    } catch (err) {
        return die(`${file}: docker compose did not return a usable model\n    ${(err as Error).message}`);
    }

    const images: string[] = [];
    for (const [name, service] of Object.entries(model.services ?? {})) {
        if (service.build !== undefined) {
            LOG.debug(`${name} is built, not pulled -- skipped`);
        } else if (typeof service.image === 'string' && service.image !== '') {
            images.push(service.image);
        }
    }

    if (images.length === 0) LOG.warn(`${file} names no images to pull`);
    return images;
}

async function pull(sandbox: Sandbox, image: string, pulled: Set<string>, failures: string[]): Promise<void> {
    if (pulled.has(image)) {
        LOG.debug(`${image} already pulled`);
        return;
    }

    pulled.add(image);

    const result = await execInSandbox(sandbox, {
        // The reference goes through the environment rather than the command
        // line: the schema already rejects anything that is not an image
        // reference, and this way nothing in the repository's config can reach
        // a shell as syntax.
        cmd: 'bash',
        args: ['-lc', 'docker pull -q "$SEU_IMAGE"'],
        env: { SEU_IMAGE: image },
        timeoutMs: PULL_TIMEOUT_MS,
    });

    if (result.ok) {
        LOG.ok(image);
    } else {
        LOG.error(image);
        report(result.stderr || result.stdout);
        failures.push(`docker pull ${image}`);
    }
}

/**
 * `dependency:get`, not a file copy: it resolves the artifact properly --
 * descriptors, parent POMs and transitives -- which is what a plugin invoked
 * from the command line in the session will go looking for.
 */
async function resolveArtifact(sandbox: Sandbox, artifact: string, failures: string[]): Promise<void> {
    const result = await execInSandbox(sandbox, {
        cmd: 'bash',
        args: ['-lc', 'mvn -B -q dependency:get -Dartifact="$SEU_ARTIFACT"'],
        env: { SEU_ARTIFACT: artifact },
        timeoutMs: MAVEN_TIMEOUT_MS,
    });

    if (result.ok) {
        LOG.ok(artifact);
    } else {
        LOG.error(artifact);
        report(result.stderr || result.stdout);
        failures.push(`mvn dependency:get ${artifact}`);
    }
}

async function runScript(sandbox: Sandbox, script: string): Promise<void> {
    LOG.info('running the install script');
    LOG.debug(`${WORK_DIR}$ ${script}`);
    warnOnRootWork(script);

    const result = await execInSandbox(sandbox, {
        // The script IS a shell command -- see ScriptStep in
        // src/config/config.ts. It runs as `seu`, in a sandbox that is
        // destroyed right after, and never on the host.
        cmd: 'bash',
        args: ['-lc', script],
        cwd: WORK_DIR,
        timeoutMs: SCRIPT_TIMEOUT_MS,
        stream: true,
    });

    if (!result.ok) {
        die(
            result.timedOut
                ? `install script did not finish within ${SCRIPT_TIMEOUT_MS / 60_000} minutes`
                : `install script failed (exit ${result.code})`,
        );
    }
    LOG.ok('install script finished');
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

    LOG.warn(`the install script contains \`${needsRoot[0]}\`, which wants root`);
    LOG.warn('    this runs as `seu`, and anything outside the home dies with this sandbox');
    LOG.warn('    system packages belong in the image (`image` in .seu/config.json)');
}

/**
 * The lines of a failure that say why, indented. A swallowed one is unreadable
 * later.
 *
 * Not simply the last few: mise's shims print a cache warning on every call
 * (its cache dir is root's, and these run as `seu`), and five of those are
 * exactly what used to be left of a Maven failure. Maven's own `[ERROR]` lines
 * are what says why, so they win when there are any.
 */
function report(output: string): void {
    const lines = output
        .trim()
        .split('\n')
        .filter((l) => l.trim() !== '' && !l.startsWith('mise WARN'));
    const errors = lines.filter((l) => l.startsWith('[ERROR]') && l.trim() !== '[ERROR]');
    for (const line of (errors.length > 0 ? errors : lines).slice(-8)) LOG.debug(`    ${line}`);
}

/**
 * Write the project's mise.toml as mise's global config in the volume, then
 * install it. Global rather than the copy in ~/work: it has to apply wherever a
 * shim is called from, and ~/work moves on to other branches.
 */
async function installToolchain(sandbox: Sandbox, mise: string): Promise<void> {
    LOG.info('installing the toolchain (mise)');
    const result = await execInSandbox(sandbox, {
        // Through the environment, not a heredoc: the file is the project's,
        // and none of it should have to survive a shell.
        cmd: 'bash',
        args: [
            '-lc',
            `set -e
             mkdir -p "$MISE_CONFIG_DIR"
             printf '%s' "$SEU_MISE_TOML" > "$MISE_CONFIG_DIR/config.toml"
             mise trust "$MISE_CONFIG_DIR/config.toml"
             mise install
             mise reshim`,
        ],
        // Away from ~/work, so only the global config is in play.
        cwd: VOLUME_MOUNT,
        env: { SEU_MISE_TOML: readFileSync(mise, 'utf8') },
        timeoutMs: MISE_TIMEOUT_MS,
        stream: true,
    });

    if (!result.ok) {
        die(
            result.timedOut
                ? `mise install did not finish within ${MISE_TIMEOUT_MS / 60_000} minutes`
                : `mise install failed (exit ${result.code})`,
        );
    }
    LOG.ok('toolchain installed');
}
