// The `seu pull` flow: /work's commits, out over a file and into a git remote.
//
// Kept apart from the command const in src/cmd/pull.ts so that loading the
// command set does not load the microsandbox SDK.

import { join } from 'node:path';
import { LOG } from '../../common/log.ts';
import { die } from '../../common/error.ts';
import { run as spawn, runOk } from '../../host.ts';
import { type Project, resolveInstance, resolveProject, takeInstanceName } from '../../config/project.ts';
import { requireSession } from '../../session.ts';
import { exec, WORK_DIR } from '../../sandbox.ts';

/** Where the bundle is written inside the guest before it is copied out. */
const GUEST_BUNDLE = '/tmp/seu.bundle';

/** Bundling is local work on a repository that fits in a VM. Minutes, at most. */
const BUNDLE_TIMEOUT_MS = 5 * 60_000;

export async function run(argv: string[]): Promise<void> {
    const { name, rest } = takeInstanceName(argv);
    for (const arg of rest) die(arg.startsWith('-') ? `unknown option for pull: ${arg}` : `pull takes one name, not ${arg}`);

    const project = await resolveProject();
    const instance = resolveInstance(project, name);
    const session = await requireSession(instance);
    const bundle = join(instance.stateDir, `${instance.slug}.bundle`);

    LOG.step(`Bundling ${WORK_DIR}`);
    const bundled = await exec(session.sandbox, {
        cmd: 'bash',
        args: ['-lc', `cd ${WORK_DIR} && git bundle create ${GUEST_BUNDLE} --all`],
        user: 'seu',
        timeoutMs: BUNDLE_TIMEOUT_MS,
        stream: true,
    });
    if (!bundled.ok) {
        die(`could not create the bundle (is there at least one commit in ${WORK_DIR}?)`);
    }

    await session.sandbox
        .fs()
        .copyToHost(GUEST_BUNDLE, bundle)
        .catch((err: Error) => die(`could not copy the bundle out: ${err.message}`));
    LOG.ok(bundle);

    const remote = process.env['SEU_REMOTE'] || `seu-${instance.name}`;
    LOG.step(`Wiring up remote '${remote}'`);
    await wireRemote(project, remote, bundle);

    await review(project, remote);
}

/**
 * Point the remote at the bundle we just wrote, creating it the first time.
 * `set-url` rather than remove-and-add so an existing one keeps whatever the
 * developer has configured on it.
 */
async function wireRemote(project: Project, remote: string, bundle: string): Promise<void> {
    const existing = await spawn('git', ['-C', project.root, 'remote', 'get-url', remote]);
    const subcommand = existing.code === 0 ? 'set-url' : 'add';

    await runOk(
        'git',
        ['-C', project.root, 'remote', subcommand, remote, bundle],
        `could not point the remote '${remote}' at ${bundle}`,
    );
    await runOk('git', ['-C', project.root, 'fetch', remote], 'git fetch from the bundle failed');
    LOG.ok(`${remote} -> ${bundle}`);
}

/**
 * The fetch is deliberately where this stops. What came out of a sandbox is
 * reviewed before it is merged, so the command hands over the commands for
 * that rather than running any of them.
 */
async function review(project: Project, remote: string): Promise<void> {
    LOG.step('Review before merging');
    for (const line of [
        `git -C "${project.root}" log --oneline HEAD..${remote}/$BRANCH`,
        `git -C "${project.root}" diff HEAD...${remote}/$BRANCH`,
        `git -C "${project.root}" merge --no-ff ${remote}/$BRANCH`,
    ]) {
        LOG.info(line);
    }

    const branches = await spawn('git', ['-C', project.root, 'branch', '-r', '--list', `${remote}/*`]);
    const fetched = branches.stdout.trim();
    if (fetched === '') return;

    LOG.step('Fetched');
    for (const branch of fetched.split('\n')) LOG.info(branch.trim());
}
