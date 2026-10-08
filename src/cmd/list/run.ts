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
import { die } from '../../common/error.ts';
import { parseArgs } from '../../common/args.ts';
import { LOG } from '../../common/log.ts';
import { resolveProject, STATE_ROOT } from '../../config/project.ts';
import { listForwards } from '../../network/forward.ts';
import { listSessions, type SessionListing } from '../../msb/session.ts';
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
 * An instance name is `<name as typed>-<8 hex digits of the worktree path>`;
 * the list shows the part that was typed.
 */
const WORKTREE_HASH_SUFFIX = /-[0-9a-f]{8}$/;

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

    const rows = (await listSessions())
        .map((listing) => toRow(listing, here))
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
 * ~/work anyone works in -- but disk that is worth knowing about.
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

function toRow(listing: SessionListing, here: string | undefined): Row {
    const forwards = listing.installing
        ? []
        : listForwards({ stateDir: join(STATE_ROOT, listing.instanceName) }).map((f) => `${f.host}->${f.guest}`);

    return {
        name: listing.instanceName.replace(WORKTREE_HASH_SUFFIX, ''),
        status: listing.installing ? `installing (${listing.status})` : listing.status,
        image: listing.image ?? '?',
        forwards: forwards.join(',') || '-',
        worktree: listing.worktree,
        here: listing.worktree === here,
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
