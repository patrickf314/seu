// Project identity: which worktree are we sandboxing, and what is everything
// derived from it called. Port of seu_resolve_project in lib/common.sh.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { CONFIG_FILE } from './config.ts';
import { run } from '../host.ts';
import { die } from '../common/error.ts';

function requireSEURoot(): string {
    const fromEnv = process.env['SEU_ROOT'];
    if (fromEnv) {
        return fromEnv;
    }

    die('Missing SEU_ROOT variable.');
}

export const SEU_ROOT = requireSEURoot();

export interface Project {
    /**
     * Absolute, symlink-resolved worktree root. Mount sources must be real
     * paths: /tmp is a symlink to /private/tmp on macOS and a mount of it fails
     * with "Not a directory".
     */
    root: string;

    name: string;
    /**
     * A separate git dir (worktree, submodule) that has to be mounted at its own
     *  absolute path, so the .git *file*'s pointer resolves unchanged inside the
     *  VM. Empty for an ordinary in-tree .git, which rides along with /src. */
    gitDir: string | null;
    /**
     * The name with hash of the worktree root, used to name the sandbox and state dir.
     */
    slug: string;
    stateDir: string;
    confFile: string;
}

export async function resolveProject(start: string = process.cwd()): Promise<Project> {
    if (!existsSync(start) || !statSync(start).isDirectory()) {
        die(`not a directory: ${start}`);
    }

    const top = await run('git', ['rev-parse', '--show-toplevel'], { cwd: start });
    if (top.code !== 0 || !top.stdout.trim()) {
        die(`not inside a git repository: ${start}`);
    }

    const root = realpathSync(top.stdout.trim());
    const name = basename(root);

    let gitDir: string | null = null;
    const common = await run('git', ['rev-parse', '--git-common-dir'], { cwd: root });

    if (common.code === 0 && common.stdout.trim()) {
        const raw = common.stdout.trim();
        const abs = isAbsolute(raw) ? raw : resolve(root, raw);
        // Only a *separate* git dir needs its own mount.
        if (existsSync(abs) && statSync(abs).isDirectory() && !realpathSync(abs).startsWith(`${root}/`)) {
            gitDir = realpathSync(abs);
        }
    }

    const hash = createHash('sha256').update(root).digest('hex').slice(0, 8);
    const slug = `${name}-${hash}`;
    const stateDir = join(process.env['SEU_STATE_DIR'] ?? join(SEU_ROOT, '.seu-state'), slug);
    mkdirSync(stateDir, { recursive: true });

    return {
        root,
        name,
        gitDir,
        slug,
        stateDir,
        confFile: join(root, CONFIG_FILE),
    };
}
