// Project identity: which worktree are we sandboxing, and what is everything
// derived from it called. Port of seu_resolve_project in lib/common.sh.

import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { CONFIG_FILE } from './config.ts';
import { execOnHost } from '../host/exec.ts';
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
     * The config file
     */
    readonly configFile: string;

    /**
     * Whether the config file was named with --config, which makes a missing
     * file an error instead of "use the defaults".
     */
    readonly configExplicit: boolean;

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
}

/**
 * One SEU of a project. A worktree can have several -- `seu start review` next
 * to the default one -- and each has its own session sandbox, named volume and
 * state dir. Only the image and the project's template are shared.
 */
export interface Instance {
    readonly project: Project;
    /**
     * `<name as typed>-<worktree hash>`: what the sandbox, the volume and the
     * state dir are named after. The hash keeps two checkouts that happen to
     * share a directory name -- or a `--name` -- apart in microsandbox's global
     * namespace.
     */
    readonly name: string;
    readonly stateDir: string;
}

const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

let configOverride: string | undefined;

/**
 * Point every later resolveProject() at this config file instead of
 * <root>/.seu/config.json. It may lie anywhere; relative paths inside it still
 * resolve against the repository root.
 */
export function setConfigOverride(file: string | undefined): void {
    configOverride = file === undefined ? undefined : resolve(process.cwd(), file);
}

export async function resolveProject(): Promise<Project> {
    const currentWorkingDirectory = process.cwd();
    if (!existsSync(currentWorkingDirectory) || !statSync(currentWorkingDirectory).isDirectory()) {
        die(`not a directory: ${currentWorkingDirectory}`);
    }

    const top = await execOnHost({ cmd: 'git', args: ['rev-parse', '--show-toplevel'], cwd: currentWorkingDirectory });
    if (top.code !== 0 || !top.stdout.trim()) {
        die(`not inside a git repository: ${currentWorkingDirectory}`);
    }

    const root = realpathSync(top.stdout.trim());
    const name = basename(root);

    let gitDir: string | null = null;
    const common = await execOnHost({ cmd: 'git', args: ['rev-parse', '--git-common-dir'], cwd: root });

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
        configFile: configOverride ?? join(root, CONFIG_FILE),
        configExplicit: configOverride !== undefined,
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

    const instanceName = `${name}-${worktreeHash(project)}`;
    // Not created here: naming a SEU that does not exist must not leave a
    // directory behind. Whatever writes into it creates it.
    return { project, name: instanceName, stateDir: join(STATE_ROOT, instanceName) };
}

/** Short hash of the worktree root. */
function worktreeHash(project: Project): string {
    return createHash('sha256').update(project.root).digest('hex').slice(0, 8);
}

/**
 * `seu <command>` as the user would type it for this instance: the name only
 * `--name` only when it is not the default, which needs none.
 */
export function seuCommand(instance: Instance, command: string): string {
    const typed = instance.name.slice(0, -`-${worktreeHash(instance.project)}`.length);
    return typed === defaultInstanceName(instance.project) ? `seu ${command}` : `seu ${command} --name ${typed}`;
}

/** The directory name, with anything a sandbox name cannot hold replaced. */
function defaultInstanceName(project: Project): string {
    const name = project.name.replace(/[^A-Za-z0-9._-]/g, '-');
    if (!INSTANCE_NAME.test(name)) {
        die(`cannot derive a SEU name from the directory name ${project.name} -- pass one`);
    }
    return name;
}
