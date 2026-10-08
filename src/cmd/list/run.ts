// The `seu list` flow: every SEU microsandbox knows about, read back from the
// sandboxes themselves.
//
// There is no registry of SEUs to go stale. A SEU IS its session sandbox, so
// the sandbox list is the source of truth: the name says which SEU it is, the
// stored config says which worktree it mounts at /src and which image it runs.
//
// Kept apart from the command const in src/cmd/list.ts so that loading the
// command set does not load the microsandbox SDK.

import { join } from 'node:path';
import type { SandboxHandle } from 'microsandbox';
import { die } from '../../common/error.ts';
import { parseArgs } from '../../common/args.ts';
import { LOG } from '../../common/log.ts';
import { resolveProject, STATE_ROOT } from '../../config/project.ts';
import { listForwards } from '../../network/forward.ts';
import { listSandboxes, SRC_MOUNT } from '../../msb/sandbox.ts';
import { sessionInstanceName } from '../../msb/session.ts';
import { listTemplates } from '../../msb/template.ts';

interface Row {
    readonly name: string;
    readonly status: string;
    readonly image: string;
    readonly forwards: string;
    readonly worktree: string;
    readonly here: boolean;
}

/**
 * The install sandbox an older `seu start` used per SEU (see
 * `installSandboxName`); one can still be left over.
 */
const INSTALL_SANDBOX_PREFIX = 'seu-install-';

/**
 * An instance name is `<name as typed>-<8 hex digits of the worktree path>`;
 * the list shows the part that was typed.
 */
const WORKTREE_HASH_SUFFIX = /-[0-9a-f]{8}$/;

/** The slice of a sandbox's stored config this command reads. */
interface StoredConfig {
    image?: { Oci?: { reference?: string } };
    mounts?: { type?: string; host?: string; guest?: string }[];
}

export async function run(argv: string[]): Promise<void> {
    const { hereOnly } = parseArgs(argv, {
        command: 'list',
        defaults: { hereOnly: false },
        flags: { '--here': { hereOnly: true } },
    }, false);

    // Outside a repository there is simply no "here"; that is not an error for
    // a command that lists the whole machine.
    const here = await currentWorktree();
    if (hereOnly && here === undefined) die('--here needs to be run inside a git worktree');

    const rows = (await listSandboxes())
        .map((sandbox) => toRow(sandbox, here))
        .filter((row): row is Row => row !== undefined)
        .filter((row) => !hereOnly || row.here)
        .sort((a, b) => a.worktree.localeCompare(b.worktree) || a.name.localeCompare(b.name));

    if (rows.length === 0) {
        LOG.info(hereOnly ? 'no SEU for this worktree -- `seu start` makes one' : 'no SEUs -- `seu start` makes one');
    } else {
        printTable(rows);
    }

    if (!hereOnly) await printTemplates();
}

/**
 * The project templates new SEUs are cloned from. Not SEUs -- no session, no
 * /work anyone works in -- but disk that is worth knowing about.
 */
async function printTemplates(): Promise<void> {
    const templates = (await listTemplates()).map((t) => [t.volume, t.image ?? '?', t.worktree ?? '?']);
    if (templates.length === 0) return;

    const rows = [['TEMPLATE', 'IMAGE', 'INSTALLED FROM'], ...templates];
    const w0 = Math.max(...rows.map((r) => r[0].length));
    const w1 = Math.max(...rows.map((r) => r[1].length));
    process.stdout.write('\n');
    for (const [name, image, worktree] of rows) {
        process.stdout.write(`  ${name.padEnd(w0)}  ${image.padEnd(w1)}  ${worktree}\n`);
    }
}

async function currentWorktree(): Promise<string | undefined> {
    try {
        return (await resolveProject()).root;
    } catch {
        return undefined;
    }
}

function toRow(sandbox: SandboxHandle, here: string | undefined): Row | undefined {
    const session = sessionInstanceName(sandbox.name);
    const install = sandbox.name.startsWith(INSTALL_SANDBOX_PREFIX)
        ? sandbox.name.slice(INSTALL_SANDBOX_PREFIX.length)
        : undefined;
    // Template install sandboxes and anything else that is not a SEU.
    const instanceName = session ?? install;
    if (instanceName === undefined) return undefined;

    let config: StoredConfig = {};
    try {
        config = JSON.parse(sandbox.configJson) as StoredConfig;
    } catch {
        // A sandbox whose config cannot be read is still worth a line.
    }

    const worktree = config.mounts?.find((m) => m.type === 'Bind' && m.guest === SRC_MOUNT)?.host;
    // Anything named like a SEU but not mounting a worktree at /src is not one.
    if (worktree === undefined) return undefined;

    const forwards = install !== undefined
        ? []
        : listForwards({ stateDir: join(STATE_ROOT, instanceName) }).map((f) => `${f.host}->${f.guest}`);

    return {
        name: instanceName.replace(WORKTREE_HASH_SUFFIX, ''),
        status: install !== undefined ? `installing (${sandbox.status})` : sandbox.status,
        image: config.image?.Oci?.reference ?? '?',
        forwards: forwards.join(',') || '-',
        worktree,
        here: worktree === here,
    };
}

function printTable(rows: readonly Row[]): void {
    const header: Row = {
        name: 'NAME',
        status: 'STATUS',
        image: 'IMAGE',
        forwards: 'PORTS',
        worktree: 'WORKTREE',
        here: false
    };
    const all = [header, ...rows];
    const width = (key: keyof Omit<Row, 'here'>): number => Math.max(...all.map((r) => r[key].length));
    const [name, status, image, forwards] = [width('name'), width('status'), width('image'), width('forwards')];

    for (const row of all) {
        const mark = row === header ? ' ' : row.here ? '*' : ' ';
        process.stdout.write(
            `${mark} ${row.name.padEnd(name)}  ${row.status.padEnd(status)}  ${row.image.padEnd(image)}  ` +
            `${row.forwards.padEnd(forwards)}  ${row.worktree}\n`,
        );
    }
}
