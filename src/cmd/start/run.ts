// The `seu start` flow: from a worktree to a shell in a running session, doing
// only what is still missing.
//
//   session exists          -> resume it
//   SEU volume exists       -> a new session over it
//   neither                 -> clone the project's template into a new volume,
//                              building the template first if there is none
//
// and then, unless --detach, straight into the shell.
//
// The template (src/cmd/start/template.ts) is where installing happens: in a
// throwaway sandbox with egress, once per project. A SEU itself never installs
// anything; its session only ever has the Anthropic-only policy.
//
// Kept apart from the command const in src/cmd/start.ts so that loading the
// command set does not load the microsandbox SDK: `seu help` has to work on a
// checkout with no node_modules, and this module is only imported once a start
// actually happens.

import type { SandboxStatus } from 'microsandbox';
import { type MicrosandboxSdk, sdk } from '../../microsandbox/microsandboxSdk.ts';
import { CONFIG_FILE, loadConfig, type SeuConfig } from '../../config/config.ts';
import { succeeds } from '../../host.ts';
import { buildBaseImage, imageLoaded, imageTag } from './image.ts';
import { obtainTemplate, type Template } from './template.ts';
import { LOG } from '../../common/log.ts';
import { die } from '../../common/error.ts';
import { sessionNetworkPolicy } from '../../network/net.ts';
import {
    type Instance,
    type Project,
    resolveInstance,
    resolveProject,
    seuCommand,
    takeInstanceName,
} from '../../config/project.ts';
import { requireSession, type Session } from '../../session.ts';
import { guardUnsavedWork, syncWorkToSource } from '../../work.ts';
import { enterShell } from '../shell/run.ts';
import { stopAllForwards } from '../../network/forward.ts';
import {
    bootstrapVolume,
    cloneVolume,
    createProjectSandbox,
    installSandboxName,
    prepareWork,
    removeSandbox,
    removeVolume,
    sandboxStatus,
    sessionSandboxName,
    volumeExists,
    volumeName,
    waitForAgent,
    WORK_DIR,
} from '../../sandbox.ts';

interface StartOptions {
    name: string | undefined;
    reinstall: boolean;
    force: boolean;
    hostM2: boolean;
    detach: boolean;
}

function parseArgs(argv: string[]): StartOptions {
    const { name, rest } = takeInstanceName(argv);
    const opts: StartOptions = { name, reinstall: false, force: false, hostM2: true, detach: false };

    for (const arg of rest) {
        switch (arg) {
            case '--reinstall':
                opts.reinstall = true;
                break;
            case '--force':
                opts.force = true;
                break;
            case '--no-host-m2':
                opts.hostM2 = false;
                break;
            case '--detach':
            case '-d':
                opts.detach = true;
                break;
            default:
                die(arg.startsWith('-') ? `unknown option for start: ${arg}` : `start takes one name, not ${arg}`);
        }
    }
    if (opts.force && !opts.reinstall) die('--force only means something with --reinstall');
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

export async function run(argv: string[]): Promise<number> {
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
        return enter(instance, await resume(instance, status), opts);
    }

    // Before anything is rebuilt: a reinstall replaces this SEU's volume, and
    // the check is cheapest to fail early.
    if (opts.reinstall && status !== 'absent') {
        LOG.step(`Checking ${WORK_DIR} of ${name}`);
        const session = await requireSession(instance);
        await guardUnsavedWork(instance, session.sandbox, opts.force, 'reinstall');
    }

    LOG.step('Base image');
    await ensureImage(tag, config, instance, opts.reinstall);

    const volume = volumeName(instance.slug);
    if (!opts.reinstall && (await volumeExists(volume))) {
        // A SEU whose session was removed but whose volume was kept
        // (`seu remove --keep-volume`): everything is still in there.
        LOG.step('Volume');
        LOG.ok(`reusing ${volume}`);
        return enter(instance, await startSession(tag, instance, false), opts);
    }

    const template = await ensureTemplate(tag, project, config, opts);

    // Only now, with the new template in hand: a reinstall that fails on the
    // way leaves the SEU as it was.
    if (opts.reinstall) await discardSeu(instance);

    LOG.step(`Cloning ${template.volume}`);
    const started = Date.now();
    await cloneVolume(template.volume, volume);
    LOG.ok(`${volume} (${Date.now() - started} ms)`);

    return enter(instance, await startSession(tag, instance, true), opts);
}

/**
 * Host Docker is only needed when there is something to build, so a start on
 * a machine whose Docker is down still works as long as the image is loaded.
 */
async function ensureImage(tag: string, config: SeuConfig, instance: Instance, rebuild: boolean): Promise<void> {
    if (!rebuild && (await imageLoaded(tag))) {
        LOG.ok(`${tag} already loaded`);
        return;
    }

    if (!(await succeeds('docker', ['info']))) {
        die('host Docker is not reachable -- needed to build the base image');
    }
    await buildBaseImage(tag, config, instance.stateDir, instance.project.root);
}

/**
 * The project's template, built when there is none -- or always on
 * --reinstall, which is how a changed install, toolchain or dependency set
 * gets into it.
 */
async function ensureTemplate(tag: string, project: Project, config: SeuConfig, opts: StartOptions): Promise<Template> {
    const { template: existing, built } = await obtainTemplate(tag, project, config, {
        rebuild: opts.reinstall,
        hostM2: opts.hostM2,
    });
    if (built) return existing;

    LOG.step('Template');
    LOG.ok(`${existing.volume}${existing.worktree ? ` (installed from ${existing.worktree})` : ''}`);
    if (existing.image !== undefined && existing.image !== tag) {
        LOG.warn(`it was installed with ${existing.image}, the toolchain is now ${tag}`);
        LOG.warn('    `seu start --reinstall` rebuilds it');
    }
    return existing;
}

/** This SEU's session, any leftover install sandbox, its forwards and its volume. */
async function discardSeu(instance: Instance): Promise<void> {
    const session = sessionSandboxName(instance);
    const volume = volumeName(instance.slug);
    if ((await sandboxStatus(session)) === 'absent' && !(await volumeExists(volume))) return;

    LOG.step(`Discarding the current ${session}`);
    await removeSandbox(installSandboxName(instance));
    await removeSandbox(session);
    stopAllForwards(instance);
    await removeVolume(volume);
    LOG.ok(`removed ${session} and ${volume}`);
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
        LOG.warn(`${name} runs on ${current}; the toolchain is now ${tag} -- \`seu start --reinstall\` to move over`);
    }
}

/**
 * A sandbox that already exists keeps its root disk, its narrowed policy and
 * everything in the volume; it only has to be running again.
 *
 * `prepareWork` still runs after a resume: it is idempotent, and it is what
 * repairs a session whose first start was interrupted before /work was cloned.
 */
async function resume(instance: Instance, status: SandboxStatus): Promise<Session> {
    if (status === 'running') {
        LOG.step('Session sandbox');
        LOG.ok(`${sessionSandboxName(instance)} is already running (pass --reinstall to install again)`);
    }

    const session = await requireSession(instance);
    if (session.resumed) await prepareWork(session.sandbox);
    return session;
}

/**
 * The session itself: the SEU's volume, the image, the narrowed policy, and a
 * lifetime of its own -- it is detached, so it stays up when this command
 * returns.
 *
 * `fromTemplate`: the volume is a fresh clone, whose /work still sits on the
 * worktree and commit the template was installed from.
 */
async function startSession(tag: string, instance: Instance, fromTemplate: boolean): Promise<Session> {
    const name = sessionSandboxName(instance);
    LOG.step(`Creating ${name} (egress: Anthropic only)`);
    const sandbox = await createProjectSandbox({
        name,
        image: tag,
        project: instance.project,
        volume: volumeName(instance.slug),
        network: { policy: await sessionNetworkPolicy(), strict: true },
        detached: true,
    });

    await waitForAgent(sandbox);
    await bootstrapVolume(sandbox);

    LOG.step(`Preparing ${WORK_DIR}`);
    await prepareWork(sandbox);
    if (fromTemplate) await syncWorkToSource(sandbox);

    LOG.ok(`${name} is running with the session network policy`);
    return { name, sandbox, resumed: false };
}

/**
 * Into the shell, unless asked not to -- or unless there is no terminal to hand
 * over, in which case the session is up and the way in is printed instead.
 */
async function enter(instance: Instance, session: Session, opts: StartOptions): Promise<number> {
    if (opts.detach || !process.stdin.isTTY) {
        LOG.step('Up');
        LOG.info(`\`${seuCommand(instance, 'shell')}\` to get in; ${WORK_DIR} is your writable clone -- run \`claude\` there`);
        return 0;
    }
    return enterShell(instance, session);
}
