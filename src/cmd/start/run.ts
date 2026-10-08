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

import { CONFIG_FILE, loadConfig, type SeuConfig } from '../../config/config.ts';
import { requireImage } from '../../msb/image.ts';
import { buildTemplate, findTemplate, type Template } from '../../msb/template.ts';
import { existsSync } from 'node:fs';
import { LOG } from '../../common/log.ts';
import { die } from '../../common/error.ts';
import { type Instance, type Project, resolveInstance, resolveProject, seuCommand, } from '../../config/project.ts';
import {
    cloneSessionVolume,
    createSession,
    discardSession,
    prepareSessionWork,
    resumeSession,
    type Session,
    sessionExists,
    sessionStatus,
    sessionVolumeExists,
} from '../../msb/session.ts';
import { guardUnsavedWork, syncWorkToSource } from '../../common/work.ts';
import { stopAllForwards } from '../../network/forward.ts';
import { WORK_DIR } from '../../msb/sandbox.ts';
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

    const status = await sessionStatus(instance);
    let session: Session;

    if (opts.reinstall || status === 'absent') {
        if (opts.reinstall && status !== 'absent') {
            LOG.step(`Checking ${WORK_DIR} of ${instance.name}`);
            await checkUnsavedWork(instance, opts.force);
        }

        LOG.step('Image');
        await requireImage(config.image);
        LOG.ok(config.image);

        // A SEU whose session was removed but whose volume was kept
        // (`seu remove --keep-volume`): everything is still in there.
        const fromTemplate = opts.reinstall || !(await sessionVolumeExists(instance));
        if (fromTemplate) {
            LOG.step('Template');
            const template = await ensureTemplate(project, config, opts);

            // Only now, with the new template in hand: a reinstall that fails
            // on the way leaves the SEU as it was.
            if (opts.reinstall && (await sessionExists(instance))) {
                LOG.step(`Discarding the current SEU ${instance.name}`);
                await discardSeu(instance);
            }

            LOG.step(`Cloning ${template.volume}`);
            await cloneSessionVolume(instance, template);
        } else {
            LOG.step('Volume');
            LOG.ok(`reusing the volume of ${instance.name}`);
        }

        LOG.step(`Creating session ${instance.name} (egress: Anthropic only)`);
        session = await createSession(instance, config);

        LOG.step(`Preparing ${WORK_DIR}`);
        await prepareSession(config, session, fromTemplate);
    } else {
        LOG.step(`Resuming session ${instance.name}`);
        session = await resume(config, instance);
    }

    // No shell when asked not to -- or when there is no terminal to hand over:
    // the session is up, and the way in is printed instead.
    if (opts.detach || !process.stdin.isTTY) {
        LOG.info(`\`${seuCommand(instance, 'shell')}\` to get in; ${WORK_DIR} is your writable clone -- run \`claude\` there`);
        return 0;
    }

    LOG.step(`Attach to session ${instance.name}`);
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

/** This SEU's session, any leftover install sandbox, its forwards and its volume. */
async function discardSeu(instance: Instance): Promise<void> {
    stopAllForwards(instance);
    await discardSession(instance);
}

/**
 * A sandbox that already exists keeps its root disk, its narrowed policy and
 * everything in the volume; it only has to be running again.
 *
 * ~/work is still prepared after a resume: that is idempotent, and it is what
 * repairs a session whose first start was interrupted before ~/work was cloned.
 */
async function resume(config: SeuConfig, instance: Instance): Promise<Session> {
    const session = await resumeSession(instance);
    if (session.resumed) {
        await prepareSessionWork(session);
    } else {
        LOG.ok(`${session.name} is already running (pass --reinstall to install again)`);
    }

    await installClaudeSettings(session.sandbox, config);
    return session;
}

/**
 * ~/work and the Claude settings of a new session.
 *
 * `fromTemplate`: the volume is a fresh clone, whose ~/work still sits on the
 * worktree and commit the template was installed from.
 */
async function prepareSession(config: SeuConfig, session: Session, fromTemplate: boolean): Promise<void> {
    await prepareSessionWork(session);
    if (fromTemplate) await syncWorkToSource(session.sandbox);
    await installClaudeSettings(session.sandbox, config);
}
