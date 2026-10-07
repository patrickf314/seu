// The `seu start` flow: from a worktree to a running session, doing only what
// is still missing -- base image, install, session.
//
// Two sandboxes, because a sandbox's network policy is fixed at creation. The
// pre-install and `install.script` resolve dependencies, so they need egress,
// and the session must have none beyond Anthropic. One sandbox cannot be both,
// so the install runs in a throwaway sandbox under the BUILD policy, writes
// everything it fetches into the instance's named volume, and is destroyed
// before the session is created over that same volume.
//
// Kept apart from the command const in src/cmd/start.ts so that loading the
// command set does not load the microsandbox SDK: `seu help` has to work on a
// checkout with no node_modules, and this module is only imported once a start
// actually happens.

import type { ExecHandle, Sandbox, SandboxStatus } from 'microsandbox';
import { type MicrosandboxSdk, sdk } from '../../microsandbox/microsandboxSdk.ts';
import { CONFIG_FILE, loadConfig, type SeuConfig } from '../../config/config.ts';
import { succeeds } from '../../host.ts';
import { buildBaseImage, imageLoaded, imageTag } from './image.ts';
import { runPreInstall } from './pre-install.ts';
import { LOG } from '../../common/log.ts';
import { die } from '../../common/error.ts';
import { buildNetworkPolicy, sessionNetworkPolicy } from '../../network/net.ts';
import { type Instance, resolveInstance, resolveProject, seuCommand, takeInstanceName } from '../../config/project.ts';
import { declareHostRepository, hostRepository, sealForOffline } from '../../maven/hostRepository.ts';
import {
    bootstrapVolume,
    createProjectSandbox,
    destroySandbox,
    ensureVolume,
    exec,
    installSandboxName,
    prepareWork,
    sandboxStatus,
    sessionSandboxName,
    startDockerd,
    startSandbox,
    stopSandbox,
    waitForAgent,
    WORK_DIR,
} from '../../sandbox.ts';

/**
 * A full `mvn clean install` on a large reactor is a long hour on a cold cache,
 * and the alternative to a generous budget is killing a build that would have
 * finished. The watchdog is only here so a wedged step cannot hang forever.
 */
const INSTALL_TIMEOUT_MS = 90 * 60_000;

interface StartOptions {
    name: string | undefined;
    rebuild: boolean;
    reinstall: boolean;
    hostM2: boolean;
}

function parseArgs(argv: string[]): StartOptions {
    const { name, rest } = takeInstanceName(argv);
    const opts: StartOptions = { name, rebuild: false, reinstall: false, hostM2: true };

    for (const arg of rest) {
        switch (arg) {
            case '--rebuild':
                // A new toolchain under an old install is the mismatch a
                // rebuild exists to get rid of.
                opts.rebuild = true;
                opts.reinstall = true;
                break;
            case '--reinstall':
                opts.reinstall = true;
                break;
            case '--no-host-m2':
                opts.hostM2 = false;
                break;
            default:
                die(arg.startsWith('-') ? `unknown option for start: ${arg}` : `start takes one name, not ${arg}`);
        }
    }
    return opts;
}

function validateMicroSandbox(resolveRuntime: MicrosandboxSdk['resolveRuntime']): void {
    try {
        const runtime = resolveRuntime();
        LOG.ok(`microsandbox runtime ${runtime.msbPath} (${runtime.origin})`);
    } catch (err) {
        die(`no usable microsandbox runtime: ${(err as Error).message}`);
    }
}

export async function run(argv: string[]): Promise<void> {
    const { resolveRuntime } = await sdk();

    const opts = parseArgs(argv);
    const project = await resolveProject();
    const instance = resolveInstance(project, opts.name);
    const config = loadConfig(project);
    const name = sessionSandboxName(instance);

    LOG.step('Checking Preconditions');
    validateMicroSandbox(resolveRuntime);
    LOG.ok(`Project Root ${project.root}`);
    LOG.ok(`SEU ${instance.name} (${name})`);
    LOG.ok(config.file === undefined ? `no ${CONFIG_FILE} -- using defaults` : `profile  ${CONFIG_FILE}`);

    const tag = imageTag(config);
    const status = await sandboxStatus(name);

    if (!opts.reinstall && status !== 'absent') {
        await warnOnStaleImage(name, tag);
        await resume(instance, name, status);
        return;
    }

    LOG.step('Base image');
    await ensureImage(tag, config, instance, opts.rebuild);

    if (status === 'running') {
        // Two sandboxes must not mount one disk volume at the same time, and the
        // install sandbox needs this one.
        LOG.step(`Stopping ${name}`);
        await stopSandbox(name);
        LOG.ok(`${name} stopped`);
    }

    LOG.step('Named volume');
    await ensureVolume(instance);

    if (config.image.preInstall.length === 0 && config.install.script === undefined) {
        LOG.step('Install');
        LOG.debug(`no image.pre-install and no install.script in ${CONFIG_FILE} -- starting the session straight away`);
    } else {
        await install(tag, instance, config, opts);
    }

    await startSession(tag, instance, name);
}

/**
 * Host Docker is only needed when there is something to build, so a start on
 * a machine whose Docker is down still works as long as the image is loaded.
 */
async function ensureImage(tag: string, config: SeuConfig, instance: Instance, rebuild: boolean): Promise<void> {
    if (!rebuild && (await imageLoaded(tag))) {
        LOG.ok(`${tag} already loaded (pass --rebuild to force)`);
        return;
    }

    if (!(await succeeds('docker', ['info']))) {
        die('host Docker is not reachable -- needed to build the base image');
    }
    await buildBaseImage(tag, config, instance.stateDir, instance.project.root);
}

/**
 * A session keeps the image it was created from. When the toolchain has moved
 * on since, resuming it is still right -- it is what you were working in -- but
 * you should know it is no longer what a fresh start would give you.
 */
async function warnOnStaleImage(name: string, tag: string): Promise<void> {
    const { Sandbox } = await sdk();
    let current: string | undefined;
    try {
        const config = JSON.parse((await Sandbox.get(name)).configJson) as { image?: { Oci?: { reference?: string } } };
        current = config.image?.Oci?.reference;
    } catch {
        return;
    }
    if (current !== undefined && current !== tag) {
        LOG.warn(`${name} runs on ${current}; the toolchain is now ${tag} -- \`seu start --rebuild\` to move over`);
    }
}

/**
 * A sandbox that already exists keeps its root disk, its narrowed policy and
 * everything in the volume; it only has to be running again.
 *
 * `bootstrapVolume` and `prepareWork` still run: they are idempotent, and they
 * are what repairs a session whose first start was interrupted before /work was
 * cloned.
 */
async function resume(instance: Instance, name: string, status: SandboxStatus): Promise<void> {
    if (status === 'running') {
        LOG.step('Session sandbox');
        LOG.ok(`${name} is already running (pass --reinstall to install again)`);
        LOG.info(`\`${seuCommand(instance, 'shell')}\` to get in`);
        return;
    }

    LOG.step(`Starting ${name} (${status})`);
    const sandbox = await startSandbox(name);
    await waitForAgent(sandbox);
    await bootstrapVolume(sandbox);
    await prepareWork(sandbox);
    ready(instance, name);
}

/**
 * Pre-install and `install.script`, in one throwaway sandbox with build egress.
 *
 * Everything it writes goes into the named volume -- /work, ~/.m2, ~/.cache and
 * /seu/docker are all in there -- so what it fetches is exactly what the
 * offline session gets. Anything it leaves outside /seu dies with this sandbox.
 */
async function install(tag: string, instance: Instance, config: SeuConfig, opts: StartOptions): Promise<void> {
    const steps = config.image.preInstall;
    const script = config.install.script;

    LOG.step('Host Maven repository');
    const hostM2 = hostRepository(opts.hostM2);

    LOG.step('Creating the install sandbox (wide network egress)');
    const sandbox = await createProjectSandbox({
        name: installSandboxName(instance),
        image: tag,
        instance,
        network: { policy: await buildNetworkPolicy(), strict: false },
        hostRepository: hostM2,
        // Throwaway: it must not outlive this command, and the teardown below
        // is what guarantees the named volume is free again afterwards.
        detached: false,
    });
    LOG.ok('Created VM for install phase');

    let dockerd: ExecHandle | undefined = undefined;
    const teardown = async (): Promise<void> => {
        await dockerd?.kill().catch(() => {});
        dockerd = undefined;

        await destroySandbox(sandbox);
        LOG.ok('Removed VM of install phase');
    };

    const onSignal = (): void => {
        void teardown().finally(() => process.exit(130));
    };

    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    try {
        await waitForAgent(sandbox);
        await bootstrapVolume(sandbox);

        if (hostM2 !== undefined) await declareHostRepository(sandbox);

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

        if (script !== undefined) {
            LOG.step(`Preparing ${WORK_DIR}`);
            await prepareWork(sandbox);
            await runInstallScript(sandbox, script);
        }

        // Before the sandbox -- and with it /host-m2 -- goes away. What was just
        // resolved is unusable offline until its origin is forgotten.
        if (hostM2 !== undefined) {
            LOG.step('Handing the repository over');
            await sealForOffline(sandbox);
        }
    } finally {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        await teardown();
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

/**
 * The session itself: the same volume, the same image, the narrowed policy, and
 * a lifetime of its own -- it is detached, so it stays up when this command
 * returns.
 */
async function startSession(tag: string, instance: Instance, name: string): Promise<void> {
    LOG.step(`Creating ${name} (egress: Anthropic only)`);
    const sandbox = await createProjectSandbox({
        name,
        image: tag,
        instance,
        network: { policy: await sessionNetworkPolicy(), strict: true },
        detached: true,
    });

    await waitForAgent(sandbox);
    await bootstrapVolume(sandbox);

    LOG.step(`Preparing ${WORK_DIR}`);
    await prepareWork(sandbox);

    ready(instance, name);
}

function ready(instance: Instance, name: string): void {
    LOG.step('Up');
    LOG.ok(`${name} is running with the session network policy`);
    LOG.info(`\`${seuCommand(instance, 'shell')}\` to get in; ${WORK_DIR} is your writable clone -- run \`claude\` there`);
    // dockerd lives in the foreground of a host-side exec (see
    // vm/dockerd-run.sh), and that exec dies with the process that opened it.
    // `start` has to return, so it cannot be the one supervising it.
    LOG.debug('dockerd is started by `seu shell`, which stays attached for the session');
}
