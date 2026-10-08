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
// The template (src/msb/template.ts) is where installing happens: in a
// throwaway sandbox with egress, once per project. A SEU itself never installs
// anything; its session only ever has the Anthropic-only policy.
//
// Kept apart from the command const in src/cmd/start.ts so that loading the
// command set does not load the microsandbox SDK: `seu help` has to work on a
// checkout with no node_modules, and this module is only imported once a start
// actually happens.

import type { SandboxStatus } from 'microsandbox';
import { CONFIG_FILE, loadConfig, type SeuConfig } from '../../config/config.ts';
import { requireImage } from '../../msb/image.ts';
import { buildTemplate, findTemplate, type Template } from '../../msb/template.ts';
import { volumeName } from '../../msb/volume.ts';
import { existsSync } from 'node:fs';
import { LOG } from '../../common/log.ts';
import { die } from '../../common/error.ts';
import { sessionNetworkPolicy } from '../../network/net.ts';
import { type Instance, type Project, resolveInstance, resolveProject, seuCommand, } from '../../config/project.ts';
import { clearSession, resumeSession, type Session, sessionStatus } from '../../msb/session.ts';
import { guardUnsavedWork, syncWorkToSource } from '../../common/work.ts';
import { stopAllForwards } from '../../network/forward.ts';
import {
    bootstrapVolume,
    installSandboxName,
    prepareWork,
    removeSandbox,
    sessionSandboxName,
    WORK_DIR,
} from '../../msb/sandbox.ts';
import { type InstanceOptions, parseArgs } from '../../common/args.ts';
import { shell } from '../../msb/shell.ts';

interface StartOptions {
    reinstall: boolean;
    force: boolean;
    hostM2: boolean;
    detach: boolean;
}

export async function run(argv: string[]): Promise<number> {
    const opts = parseStartArgs(argv);

    LOG.step('Metadata')
    const project = await resolveProject();
    const config = loadConfig(project);
    const instance = resolveInstance(project, opts.name);
    const name = sessionSandboxName(instance);
    logMetadata(project, instance);

    const status = await sessionStatus(instance);
    if (!opts.reinstall && status !== 'absent') {
        return enter(config, instance, await resume(instance, status), opts);
    }

    // Before anything is rebuilt: a reinstall replaces this SEU's volume, and
    // the check is cheapest to fail early.
    if (opts.reinstall && status !== 'absent') {
        LOG.step(`Checking ${WORK_DIR} of ${name}`);
        const sandbox = await resumeSession(instance);
        await guardUnsavedWork(instance, sandbox, opts.force, 'reinstall');
    }

    LOG.step('Image');
    await requireImage(config.image);
    LOG.ok(config.image);

    const volume = volumeName(instance.name);
    if (!opts.reinstall && (await volumeExists(volume))) {
        // A SEU whose session was removed but whose volume was kept
        // (`seu remove --keep-volume`): everything is still in there.
        LOG.step('Volume');
        LOG.ok(`reusing ${volume}`);
        return enter(config, instance, await startSession(config.image, instance, false), opts);
    }

    const template = await ensureTemplate(project, config, opts);

    // Only now, with the new template in hand: a reinstall that fails on the
    // way leaves the SEU as it was.
    if (opts.reinstall) await discardSeu(instance);

    LOG.step(`Cloning ${template.volume}`);
    const started = Date.now();
    await cloneVolume(template.volume, volume);
    LOG.ok(`${volume} (${Date.now() - started} ms)`);

    return enter(config, instance, await startSession(config.image, instance, true), opts);
}

function parseStartArgs(argv: string[]): StartOptions & InstanceOptions {
    const opts = parseArgs<StartOptions>(argv, {
        command: 'start',
        defaults: { reinstall: false, force: false, hostM2: true, detach: false },
        flags: {
            '--reinstall': { reinstall: true },
            '--force': { force: true },
            '--no-host-m2': { hostM2: false },
            '--detach': { detach: true },
            '-d': { detach: true },
        },
    });

    if (opts.force && !opts.reinstall) {
        die('--force only means something with --reinstall');
    }

    return opts;
}

function logMetadata(project: Project, instance: Instance): void {
    LOG.ok(`        Name: ${project.name}`);
    LOG.ok(`        Root: ${project.root}`);
    LOG.ok(`      Config: ${existsSync(project.configFile) ? project.configFile : `no ${CONFIG_FILE} -- using defaults`}`);
    LOG.ok(`    Instance: ${instance.name}`);
}

/**
 * The project's template: the existing one while it still matches the config,
 * otherwise -- or always on --reinstall -- a freshly built one.
 */
async function ensureTemplate(project: Project, config: SeuConfig, opts: StartOptions): Promise<Template> {
    LOG.step('Template');
    const existing = await findTemplate(project, config);

    if (existing === undefined) {
        LOG.debug('absent -- building it');
    } else if (opts.reinstall) {
        LOG.debug(`rebuilding ${existing.volume} (--reinstall)`);
    } else if (existing.outdated !== undefined) {
        LOG.debug(`rebuilding ${existing.volume}: ${existing.outdated}`);
    } else {
        LOG.ok(`reusing ${existing.volume}${existing.worktree ? ` (installed from ${existing.worktree})` : ''}`);
        return existing;
    }

    return buildTemplate(project, config, { hostM2: opts.hostM2 });
}

/** This SEU's session, any leftover install sandbox, its forwards and its volume. */
async function discardSeu(instance: Instance): Promise<void> {
    await clearSession(instance);

    const volume = volumeName(instance.name);
    if ((await sessionStatus(instance)) === 'absent' && !(await volumeExists(volume))) return;

    LOG.step(`Discarding the current ${session}`);
    await removeSandbox(installSandboxName(instance));
    await removeSandbox(session);
    stopAllForwards(instance);
    await removeVolume(volume);
    LOG.ok(`removed ${session} and ${volume}`);
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

    const session = await resumeSession(instance);
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
async function startSession(image: string, instance: Instance, fromTemplate: boolean): Promise<Session> {
    const name = sessionSandboxName(instance);
    LOG.step(`Creating ${name} (egress: Anthropic only)`);
    const sandbox = await createProjectSandbox({
        name,
        image: image,
        project: instance.project,
        volume: volumeName(instance.name),
        network: { policy: await sessionNetworkPolicy(), strict: true },
        detached: true,
    });

    await sandboxReady(sandbox);
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
async function enter(config: SeuConfig, instance: Instance, session: Session, opts: StartOptions): Promise<number> {
    if (opts.detach || !process.stdin.isTTY) {
        LOG.info(`\`${seuCommand(instance, 'shell')}\` to get in; ${WORK_DIR} is your writable clone -- run \`claude\` there`);
        return 0;
    }

    LOG.step(`Attach with ${session.name}`);
    return shell(config, session);
}
