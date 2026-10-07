// /work: the SEU's writable clone of the worktree, and the only place in a SEU
// where work can exist that exists nowhere else.

import type { Sandbox } from 'microsandbox';
import { LOG } from './common/log.ts';
import { die } from './common/error.ts';
import { run } from './host.ts';
import type { Instance } from './config/project.ts';
import { exec, SRC_MOUNT, WORK_DIR } from './sandbox.ts';

export interface UnsavedWork {
    /** `git status --porcelain` lines. */
    readonly changes: readonly string[];
    /** Branches whose tip commit the host repository does not have. */
    readonly branches: readonly string[];
}

/**
 * What would be lost with this SEU's volume: uncommitted changes in /work, and
 * branches whose tip the host repository does not have.
 *
 * "Does the host have the commit" rather than "is it merged": a `seu pull`
 * fetches into the remote `seu-<name>`, and fetched is enough -- the commits are
 * safe on the host whether or not they have been merged yet.
 *
 * Undefined when /work could not be inspected at all, which callers must treat
 * as "unknown", not as "nothing".
 */
export async function unsavedWork(instance: Instance, sandbox: Sandbox): Promise<UnsavedWork | undefined> {
    const state = await exec(sandbox, {
        cmd: 'bash',
        args: ['-c', 'git status --porcelain && echo "--refs--" && git for-each-ref refs/heads --format="%(objectname) %(refname:short)"'],
        user: 'seu',
        cwd: WORK_DIR,
        timeoutMs: 60_000,
    });
    if (!state.ok) {
        LOG.warn(`could not inspect ${WORK_DIR}: ${(state.stderr || state.stdout).trim().split('\n').pop() ?? ''}`);
        return undefined;
    }

    const [porcelain, refs = ''] = state.stdout.split('--refs--\n');
    const changes = porcelain.trim().split('\n').filter((l) => l !== '');

    const branches: string[] = [];
    for (const line of refs.trim().split('\n').filter((l) => l !== '')) {
        const [sha, branch] = line.split(' ');
        const known = await run('git', ['-C', instance.project.root, 'cat-file', '-e', `${sha}^{commit}`]);
        if (known.code !== 0) branches.push(branch);
    }
    return { changes, branches };
}

/**
 * Refuse to go on when /work holds work the host does not have, unless forced.
 * `what` names the action, for the message.
 */
export async function guardUnsavedWork(instance: Instance, sandbox: Sandbox, force: boolean, what: string): Promise<void> {
    const unsaved = await unsavedWork(instance, sandbox);
    if (unsaved !== undefined && unsaved.changes.length === 0 && unsaved.branches.length === 0) {
        LOG.ok(`${WORK_DIR} has nothing the host does not have`);
        return;
    }

    if (unsaved !== undefined) {
        if (unsaved.changes.length > 0) LOG.warn(`${unsaved.changes.length} uncommitted change(s) in ${WORK_DIR}`);
        if (unsaved.branches.length > 0) LOG.warn(`branches with commits the host does not have: ${unsaved.branches.join(', ')}`);
    }
    if (force) {
        LOG.warn('--force: discarding it');
        return;
    }
    die(
        unsaved === undefined
            ? `${WORK_DIR} could not be checked for unpulled work -- pass --force to ${what} anyway`
            : `${WORK_DIR} has work that exists only in this SEU -- commit and \`seu pull\` it first, or pass --force to ${what} anyway`,
    );
}

/**
 * Move a /work that came from a template onto this worktree's state.
 *
 * The template's /work is a clone of whichever worktree built the template, at
 * the commit it had then -- plus everything its install produced: `target/`,
 * `node_modules`, generated sources. Those are the point of reusing it, and
 * they are all git-ignored, so the move is done with git rather than by
 * cloning again: fetch from /src (always the CURRENT worktree), check its HEAD
 * out under its branch name, drop the template's other branches and untracked
 * files -- `git clean` without -x leaves ignored ones alone -- and carry the
 * worktree's uncommitted changes over, the way a fresh clone would.
 */
export async function syncWorkToSource(sandbox: Sandbox): Promise<void> {
    const script = String.raw`
set -euo pipefail
cd ${WORK_DIR}
head=$(git -C ${SRC_MOUNT} rev-parse HEAD)
branch=$(git -C ${SRC_MOUNT} symbolic-ref --quiet --short HEAD || true)

git remote set-url origin ${SRC_MOUNT}
git fetch --quiet --no-tags origin '+refs/heads/*:refs/remotes/origin/*'
git reset --quiet --hard
git clean -fdq
if [ -n "$branch" ]; then
  git checkout --quiet -B "$branch" "$head"
  git branch --quiet --set-upstream-to "origin/$branch" "$branch" 2>/dev/null || true
else
  git checkout --quiet --detach "$head"
fi
git for-each-ref --format='%(refname:short)' refs/heads | { grep -vxF "$branch" || true; } | xargs -r git branch --quiet -D

if ! git -C ${SRC_MOUNT} diff --quiet HEAD; then
  git -C ${SRC_MOUNT} diff HEAD | git apply --index - || echo "could not apply all uncommitted changes from ${SRC_MOUNT}" >&2
fi
echo "$branch $head"
`;
    const result = await exec(sandbox, { cmd: 'bash', args: ['-c', script], user: 'seu', timeoutMs: 10 * 60_000 });
    if (!result.ok) {
        const detail = (result.stderr || result.stdout).trim().split('\n').slice(-5).join('\n    ');
        die(`could not move ${WORK_DIR} onto this worktree\n    ${detail}`);
    }
    const [branch, head] = result.stdout.trim().split('\n').pop()!.split(' ');
    LOG.ok(`${WORK_DIR} at ${branch || 'detached'} ${head.slice(0, 10)}, build outputs of the template kept`);
    for (const line of result.stderr.trim().split('\n').filter((l) => l !== '')) LOG.warn(line);
}
