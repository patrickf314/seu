// Where the UI tests leave their Playwright traces, and how to find and
// describe them. Nothing here prompts or prints; `seu playwright` does that.

import type { Sandbox } from 'microsandbox';
import { WORK_DIR } from '../common/constants.ts';
import { execInSandbox } from '../msb/exec.ts';

/** Where the UI tests write their traces, below each module. */
export const TRACES_DIR = 'target/ui-tests/traces';

export interface RecentTrace {
    /** Relative to ~/work. */
    readonly rel: string;
    readonly mtimeMs: number;
}

/** The newest traces any module under ~/work has written, newest first. */
export async function findRecentTraces(sandbox: Sandbox, count: number): Promise<RecentTrace[]> {
    const found = await execInSandbox(sandbox, {
        cmd: 'bash',
        args: [
            '-c',
            'find . \\( -name node_modules -o -name .git \\) -prune -o ' +
                `-path "*/${TRACES_DIR}/*" -name '*.zip' -type f -printf '%T@ %p\\n' ` +
                '| sort -rn',
        ],
        cwd: WORK_DIR,
        timeoutMs: 60_000,
    });
    if (!found.ok) return [];

    const traces: RecentTrace[] = [];
    for (const line of found.stdout.split('\n')) {
        const space = line.indexOf(' ');
        if (space < 0) continue;
        const rel = line.slice(space + 1).replace(/^\.\//, '');
        // Held to the same character class as a path typed on the command line.
        if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(rel) || rel.split('/').includes('..')) continue;
        traces.push({ rel, mtimeMs: Number(line.slice(0, space)) * 1000 });
        if (traces.length === count) break;
    }
    return traces;
}

/** `club/ui/target/ui-tests/traces/de/x/FooTest/testBar.zip` -> `club/ui  de.x.FooTest  testBar`. */
export function describeTrace(rel: string): string {
    const at = rel.indexOf(`${TRACES_DIR}/`);
    if (at < 0) return rel;
    const module = rel.slice(0, at).replace(/\/$/, '');
    const segments = rel.slice(at + TRACES_DIR.length + 1).replace(/\.zip$/, '').split('/');
    const test = segments.pop() ?? '';
    return `${module}  ${segments.join('.')}  ${test}`;
}

export function age(mtimeMs: number): string {
    const seconds = Math.max(0, Math.round((Date.now() - mtimeMs) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
    return `${Math.round(seconds / 86_400)}d ago`;
}
