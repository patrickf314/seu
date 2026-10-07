// Project identity: which worktree are we sandboxing, and what is everything
// derived from it called. Port of seu_resolve_project in lib/common.sh.

import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
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

/**
 * Where every per-project state directory lives, plus the handful of things
 * that are seu's rather than one project's -- the SSH key `seu port` forwards
 * over. SEU_STATE_DIR relocates all of it.
 */
export const STATE_ROOT = process.env['SEU_STATE_DIR'] ?? join(SEU_ROOT, '.seu-state');

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
     * Short hash of the worktree root. Keeps two checkouts that happen to share
     * a directory name apart in microsandbox's global namespace.
     */
    hash: string;
    confFile: string;
}

/**
 * One SEU of a project. A worktree can have several -- `seu start review` next
 * to the default one -- and each has its own session sandbox, named volume and
 * state dir. Only the base image is shared: it holds the toolchain, which is the
 * project's, not the instance's.
 */
export interface Instance {
    readonly project: Project;
    /** As the user types it. Defaults to the worktree's directory name. */
    readonly name: string;
    /**
     * `<name>-<project hash>`: what the sandbox, the volume and the state dir
     * are named after. For the default instance this is exactly what the
     * single-instance seu used, so existing sessions are picked up unchanged.
     */
    readonly slug: string;
    readonly stateDir: string;
}

const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

    return {
        root,
        name,
        gitDir,
        hash: createHash('sha256').update(root).digest('hex').slice(0, 8),
        confFile: join(root, CONFIG_FILE),
    };
}

/**
 * The instance called `name`, or the project's default one.
 *
 * The name ends up in sandbox and volume names, so it is held to what those
 * accept rather than passed through.
 */
export function resolveInstance(project: Project, name: string = defaultInstanceName(project)): Instance {
    if (!INSTANCE_NAME.test(name)) {
        die(`not a usable SEU name: ${name} -- letters, digits, '.', '_' and '-' only`);
    }

    const slug = `${name}-${project.hash}`;
    // Not created here: naming a SEU that does not exist must not leave a
    // directory behind. Whatever writes into it creates it.
    return { project, name, slug, stateDir: join(STATE_ROOT, slug) };
}

/**
 * `seu <command>` as the user would type it for this instance: the name only
 * when it is not the default, which needs none.
 */
export function seuCommand(instance: Instance, command: string): string {
    return instance.name === defaultInstanceName(instance.project) ? `seu ${command}` : `seu ${command} ${instance.name}`;
}

/** The directory name, with anything a sandbox name cannot hold replaced. */
function defaultInstanceName(project: Project): string {
    const name = project.name.replace(/[^A-Za-z0-9._-]/g, '-');
    if (!INSTANCE_NAME.test(name)) {
        die(`cannot derive a SEU name from the directory name ${project.name} -- pass one`);
    }
    return name;
}

/**
 * Split an optional leading instance name off a command's argv. Options stay
 * where they are; a second positional is the caller's to refuse.
 */
export function takeInstanceName(argv: readonly string[]): { name: string | undefined; rest: string[] } {
    const index = argv.findIndex((a) => !a.startsWith('-'));
    if (index === -1) return { name: undefined, rest: [...argv] };
    return { name: argv[index], rest: argv.filter((_, i) => i !== index) };
}
