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

import type { Sandbox, SandboxStatus } from 'microsandbox';
import { CONFIG_FILE, loadConfig, type SeuConfig } from '../../config/config.ts';
import { requireImage } from '../../msb/image.ts';
import { buildTemplate, findTemplate, type Template } from '../../msb/template.ts';
import { cloneVolume, removeVolume, volumeExists, volumeName } from '../../msb/volume.ts';
import { existsSync } from 'node:fs';
import { LOG } from '../../common/log.ts';
import { die } from '../../common/error.ts';
import { sessionNetworkPolicy } from '../../network/net.ts';
import { type Instance, type Project, resolveInstance, resolveProject, seuCommand, } from '../../config/project.ts';
import { clearSession, resumeSession, type Session, sessionSandboxName, sessionStatus } from '../../msb/session.ts';
import { guardUnsavedWork, syncWorkToSource } from '../../common/work.ts';
import { stopAllForwards } from '../../network/forward.ts';
import {
    createSandbox,
    installSandboxName,
    prepareWork,
    removeSandbox,
    sandboxReady,
    WORK_DIR,
} from '../../msb/sandbox.ts';
import { type InstanceOptions, parseArgs } from '../../common/args.ts';
import { shell } from '../../msb/shell.ts';
import { installClaudeSettings } from '../../claude/settings.ts';

interface StartOptions {
    reinstall: boolean;
    force: boolean;
    hostM2: boolean;
    detach: boolean;
}

export async function run(argv: string[]): Promise<number> {
    const opts = parseStartArgs(argv);

    LOG.step('Metadata');
    const project = await resolveProject();
    const config = loadConfig(project);
    const instance = resolveInstance(project, opts.name);
    logMetadata(project, instance);

    const name = sessionSandboxName(instance);
    const volume = volumeName(instance.name);
    const status = await sessionStatus(instance);
    let session: Session;

    if (!opts.reinstall && status !== 'absent') {
        LOG.step(`Resuming ${name}`);
        session = await resume(config, instance, status);
    } else {
        // Before anything is rebuilt: a reinstall replaces this SEU's volume,
        // and the check is cheapest to fail early.
        if (opts.reinstall && status !== 'absent') {
            LOG.step(`Checking ${WORK_DIR} of ${name}`);
            await checkUnsavedWork(instance, opts.force);
        }

        LOG.step('Image');
        await requireImage(config.image);
        LOG.ok(config.image);

        // A SEU whose session was removed but whose volume was kept
        // (`seu remove --keep-volume`): everything is still in there.
        const fromTemplate = opts.reinstall || !(await volumeExists(volume));
        if (fromTemplate) {
            LOG.step('Template');
            const template = await ensureTemplate(project, config, opts);

            // Only now, with the new template in hand: a reinstall that fails
            // on the way leaves the SEU as it was.
            if (opts.reinstall && (await seuExists(instance))) {
                LOG.step(`Discarding the current ${name}`);
                await discardSeu(instance);
            }

            LOG.step(`Cloning ${template.volume}`);
            await cloneTemplate(template, volume);
        } else {
            LOG.step('Volume');
            LOG.ok(`reusing ${volume}`);
        }

        LOG.step(`Creating ${name} (egress: Anthropic only)`);
        const sandbox = await createSession(config, instance);

        LOG.step(`Preparing ${WORK_DIR}`);
        await prepareSession(config, sandbox, fromTemplate);
        session = { name, sandbox, resumed: false };
    }

    // No shell when asked not to -- or when there is no terminal to hand over:
    // the session is up, and the way in is printed instead.
    if (opts.detach || !process.stdin.isTTY) {
        LOG.info(`\`${seuCommand(instance, 'shell')}\` to get in; ${WORK_DIR} is your writable clone -- run \`claude\` there`);
        return 0;
    }

    LOG.step(`Attach with ${name}`);
    return shell(config, session);
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
 * Refuses unless ~/work of the existing session holds nothing the host does not
 * have, or --force says to discard it.
 */
async function checkUnsavedWork(instance: Instance, force: boolean): Promise<void> {
    const session = await resumeSession(instance);
    await guardUnsavedWork(instance, session.sandbox, force, 'reinstall');
}

/**
 * The project's template: the existing one while it still matches the config,
 * otherwise -- or always on --reinstall -- a freshly built one.
 */
async function ensureTemplate(project: Project, config: SeuConfig, opts: StartOptions): Promise<Template> {
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

/** Whether there is anything of this SEU left: its session or its volume. */
async function seuExists(instance: Instance): Promise<boolean> {
    return (await sessionStatus(instance)) !== 'absent' || (await volumeExists(volumeName(instance.name)));
}

/** This SEU's session, any leftover install sandbox, its forwards and its volume. */
async function discardSeu(instance: Instance): Promise<void> {
    const session = sessionSandboxName(instance);
    const volume = volumeName(instance.name);

    await removeSandbox(installSandboxName(instance));
    await clearSession(instance);
    stopAllForwards(instance);
    await removeVolume(volume);
    LOG.ok(`removed ${session} and ${volume}`);
}

/** The SEU's volume as a clone of the template's. */
async function cloneTemplate(template: Template, volume: string): Promise<void> {
    const started = Date.now();
    await cloneVolume(template.volume, volume);
    LOG.ok(`${volume} (${Date.now() - started} ms)`);
}

/**
 * A sandbox that already exists keeps its root disk, its narrowed policy and
 * everything in the volume; it only has to be running again.
 *
 * `prepareWork` still runs after a resume: it is idempotent, and it is what
 * repairs a session whose first start was interrupted before ~/work was cloned.
 */
async function resume(config: SeuConfig, instance: Instance, status: SandboxStatus): Promise<Session> {
    if (status === 'running') {
        LOG.ok(`${sessionSandboxName(instance)} is already running (pass --reinstall to install again)`);
    }

    const session = await resumeSession(instance);
    if (session.resumed) await prepareWork(session.sandbox);
    await installClaudeSettings(session.sandbox, config);
    return session;
}

/**
 * The session sandbox itself: the SEU's volume, the image, the narrowed policy,
 * and a lifetime of its own -- it is detached, so it stays up when this command
 * returns.
 */
async function createSession(config: SeuConfig, instance: Instance): Promise<Sandbox> {
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
    return sandbox;
}

/**
 * ~/work and the Claude settings of a new session.
 *
 * `fromTemplate`: the volume is a fresh clone, whose ~/work still sits on the
 * worktree and commit the template was installed from.
 */
async function prepareSession(config: SeuConfig, sandbox: Sandbox, fromTemplate: boolean): Promise<void> {
    await prepareWork(sandbox);
    if (fromTemplate) await syncWorkToSource(sandbox);
    await installClaudeSettings(sandbox, config);
}
