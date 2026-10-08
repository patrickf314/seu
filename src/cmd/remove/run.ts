// The `seu remove` flow: a SEU gone for good, but never silently with work in
// it that exists nowhere else.
//
// Kept apart from the command const in src/cmd/remove.ts so that loading the
// command set does not load the microsandbox SDK.

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { LOG } from '../../common/log.ts';
import { die } from '../../common/error.ts';
import { type Instance, resolveInstance, resolveProject, seuCommand } from '../../config/project.ts';
import { listForwards, stopAllForwards } from '../../network/forward.ts';
import { resumeSession, sessionSandboxName } from '../../msb/session.ts';
import { guardUnsavedWork } from '../../common/work.ts';
import { installSandboxName, removeSandbox, sandboxStatus, WORK_DIR } from '../../msb/sandbox.ts';
import { removeVolume, volumeExists, volumeName } from '../../msb/volume.ts';
import { parseArgs } from '../../common/args.ts';

interface RemoveOptions {
    keepVolume: boolean;
    yes: boolean;
    force: boolean;
}

export async function run(argv: string[]): Promise<void> {
    const opts = parseArgs<RemoveOptions>(argv, {
        command: 'remove',
        defaults: { keepVolume: false, yes: false, force: false },
        flags: {
            '--keep-volume': { keepVolume: true },
            '--yes': { yes: true },
            '-y': { yes: true },
            '--force': { force: true },
        },
    });
    const instance = resolveInstance(await resolveProject(), opts.name);
    const session = sessionSandboxName(instance);
    const install = installSandboxName(instance);

    const sessionStatus = await sandboxStatus(session);
    const installStatus = await sandboxStatus(install);
    const hasVolume = !opts.keepVolume && (await volumeExists(volumeName(instance.name)));

    if (sessionStatus === 'absent' && installStatus === 'absent' && !hasVolume) {
        die(`there is no SEU called ${instance.name} in this worktree -- \`seu list --here\` shows them`);
    }

    LOG.step(`Removing SEU ${instance.name}`);
    if (sessionStatus !== 'absent') LOG.info(`sandbox ${session} (${sessionStatus})`);
    if (installStatus !== 'absent') LOG.info(`sandbox ${install} (${installStatus})`);
    if (hasVolume) LOG.info(`volume  ${volumeName(instance.name)} -- ~/work, ~/.m2, ~/.cache, Docker images`);
    if (opts.keepVolume) LOG.info('the volume is kept (--keep-volume)');

    // The volume is where unpulled work lives; with it kept, nothing is lost.
    if (!opts.keepVolume) await checkWork(instance, sessionStatus, opts.force);
    if (!opts.yes) await confirm(instance);

    if (installStatus !== 'absent') {
        await removeSandbox(install);
        LOG.ok(`removed ${install}`);
    }
    if (sessionStatus !== 'absent') {
        await removeSandbox(session);
        LOG.ok(`removed ${session}`);
    }

    const forwards = listForwards(instance);
    stopAllForwards(instance);
    for (const f of forwards) LOG.ok(`dropped forward ${f.bind}:${f.host} -> vm:${f.guest}`);

    if (opts.keepVolume) return;

    if (await removeVolume(volumeName(instance.name))) LOG.ok(`removed ${volumeName(instance.name)}`);
    removeState(instance);
}

/**
 * The volume is where unpulled work lives, so it is checked first. Only a
 * running session can be looked into; starting one just to check it would be a
 * surprise, so a stopped one is reported and left to the confirmation.
 */
async function checkWork(instance: Instance, status: string, force: boolean): Promise<void> {
    if (status !== 'running') {
        LOG.warn(
            status === 'absent'
                ? `no session sandbox to look into ${WORK_DIR} with -- it cannot be checked for unpulled work`
                : `${sessionSandboxName(instance)} is ${status}, so ${WORK_DIR} cannot be checked for unpulled work ` +
                      `-- \`${seuCommand(instance, 'start')} --detach\` first to have it checked`,
        );
        return;
    }
    const session = await resumeSession(instance);
    await guardUnsavedWork(instance, session.sandbox, force, 'remove');
}

/** Typing the name, not `y`: this is the step that loses a volume. */
async function confirm(instance: Instance): Promise<void> {
    if (!process.stdin.isTTY) die('not a terminal, so nothing to confirm with -- pass --yes');

    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
        const answer = await rl.question(`\n  type ${instance.name} to confirm: `);
        if (answer.trim() !== instance.name) die('not confirmed -- nothing was removed');
    } finally {
        rl.close();
    }
}

/**
 * Everything in the state dir but the `seu pull` bundle: the git remote
 * `seu-<name>` points at it, and what was fetched from it may not be merged.
 */
function removeState(instance: Instance): void {
    if (!existsSync(instance.stateDir)) return;

    let kept = false;
    for (const entry of readdirSync(instance.stateDir)) {
        if (entry.endsWith('.bundle')) {
            kept = true;
        } else {
            rmSync(join(instance.stateDir, entry), { recursive: true, force: true });
        }
    }

    if (kept) {
        LOG.info(`kept the \`seu pull\` bundle for remote seu-${instance.name} -- \`git remote remove seu-${instance.name}\` once merged`);
    } else {
        rmSync(instance.stateDir, { recursive: true, force: true });
    }
}
