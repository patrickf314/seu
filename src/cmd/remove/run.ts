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
import { run as spawn } from '../../host.ts';
import { type Instance, resolveInstance, resolveProject, seuCommand, takeInstanceName } from '../../config/project.ts';
import { listForwards, stopAllForwards } from '../../network/forward.ts';
import { sdk } from '../../microsandbox/microsandboxSdk.ts';
import {
    exec,
    installSandboxName,
    removeSandbox,
    removeVolume,
    sandboxStatus,
    sessionSandboxName,
    volumeName,
    WORK_DIR,
} from '../../sandbox.ts';

interface RemoveOptions {
    name: string | undefined;
    keepVolume: boolean;
    yes: boolean;
    force: boolean;
}

function parseArgs(argv: string[]): RemoveOptions {
    const { name, rest } = takeInstanceName(argv);
    const opts: RemoveOptions = { name, keepVolume: false, yes: false, force: false };

    for (const arg of rest) {
        switch (arg) {
            case '--keep-volume':
                opts.keepVolume = true;
                break;
            case '--yes':
            case '-y':
                opts.yes = true;
                break;
            case '--force':
                opts.force = true;
                break;
            default:
                die(arg.startsWith('-') ? `unknown option for remove: ${arg}` : `remove takes one name, not ${arg}`);
        }
    }
    return opts;
}

export async function run(argv: string[]): Promise<void> {
    const opts = parseArgs(argv);
    const instance = resolveInstance(await resolveProject(), opts.name);
    const session = sessionSandboxName(instance);
    const install = installSandboxName(instance);

    const sessionStatus = await sandboxStatus(session);
    const installStatus = await sandboxStatus(install);
    const hasVolume = !opts.keepVolume && (await volumeExists(instance));

    if (sessionStatus === 'absent' && installStatus === 'absent' && !hasVolume) {
        die(`there is no SEU called ${instance.name} in this worktree -- \`seu list --here\` shows them`);
    }

    LOG.step(`Removing SEU ${instance.name}`);
    if (sessionStatus !== 'absent') LOG.info(`sandbox ${session} (${sessionStatus})`);
    if (installStatus !== 'absent') LOG.info(`sandbox ${install} (${installStatus})`);
    if (hasVolume) LOG.info(`volume  ${volumeName(instance.slug)} -- /work, ~/.m2, ~/.cache, Docker images`);
    if (opts.keepVolume) LOG.info('the volume is kept (--keep-volume)');

    // The volume is where unpulled work lives; with it kept, nothing is lost.
    if (!opts.keepVolume) await guardUnsavedWork(instance, sessionStatus, opts.force);
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

    if (await removeVolume(instance)) LOG.ok(`removed ${volumeName(instance.slug)}`);
    removeState(instance);
}

async function volumeExists(instance: Instance): Promise<boolean> {
    const { Volume } = await sdk();
    return (await Volume.list()).some((v) => v.name === volumeName(instance.slug));
}

/**
 * Refuse to destroy work that is only in /work: uncommitted changes, and
 * branches whose tip commit the host repository does not have.
 *
 * "Does the host have the commit" rather than "is it merged": a `seu pull`
 * fetches into the remote `seu-<name>`, and fetched is enough -- the commits
 * are safe on the host whether or not they have been merged yet.
 */
async function guardUnsavedWork(instance: Instance, status: string, force: boolean): Promise<void> {
    if (status !== 'running') {
        // The confirmation still stands between this and the volume; it just
        // has to be given without the check behind it.
        LOG.warn(
            status === 'absent'
                ? `no session sandbox to look into ${WORK_DIR} with -- it cannot be checked for unpulled work`
                : `${sessionSandboxName(instance)} is ${status}, so ${WORK_DIR} cannot be checked for unpulled work ` +
                      `-- \`${seuCommand(instance, 'start')}\` first to have it checked`,
        );
        return;
    }

    const { Sandbox } = await sdk();
    // connect(), not start(): this process only looks, and must not take the
    // sandbox's lifecycle with it.
    const sandbox = await (await Sandbox.get(sessionSandboxName(instance))).connect();

    const state = await exec(sandbox, {
        cmd: 'bash',
        args: ['-c', 'git status --porcelain && echo "--refs--" && git for-each-ref refs/heads --format="%(objectname) %(refname:short)"'],
        user: 'seu',
        cwd: WORK_DIR,
        timeoutMs: 60_000,
    });
    if (!state.ok) {
        LOG.warn(`could not inspect ${WORK_DIR}: ${(state.stderr || state.stdout).trim().split('\n').pop() ?? ''}`);
        return;
    }

    const [porcelain, refs = ''] = state.stdout.split('--refs--\n');
    const changes = porcelain.trim().split('\n').filter((l) => l !== '');

    const unsaved: string[] = [];
    for (const line of refs.trim().split('\n').filter((l) => l !== '')) {
        const [sha, branch] = line.split(' ');
        const known = await spawn('git', ['-C', instance.project.root, 'cat-file', '-e', `${sha}^{commit}`]);
        if (known.code !== 0) unsaved.push(branch);
    }

    if (changes.length === 0 && unsaved.length === 0) {
        LOG.ok(`${WORK_DIR} has nothing the host does not have`);
        return;
    }

    if (changes.length > 0) LOG.warn(`${changes.length} uncommitted change(s) in ${WORK_DIR}`);
    if (unsaved.length > 0) LOG.warn(`branches with commits the host does not have: ${unsaved.join(', ')}`);
    if (force) {
        LOG.warn('--force: discarding them');
        return;
    }
    die(`${WORK_DIR} has work that exists only in this SEU -- commit and \`seu pull\` it first, or pass --force`);
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
