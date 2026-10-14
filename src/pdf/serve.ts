// Finding a PDF in the session and serving it. Nothing here prompts, prints or
// knows about the host side forward; `seu pdf` does that.

import type { Sandbox } from 'microsandbox';
import { WORK_DIR } from '../common/constants.ts';
import { execInSandbox } from '../msb/exec.ts';
import { type Viewer, watchProcess } from '../playwright/viewer.ts';

/** The name the PDF is served under; the URL does not depend on the real one. */
export const SERVED_NAME = 'document.pdf';

export interface RecentPdf {
    /** Relative to ~/work. */
    readonly rel: string;
    readonly mtimeMs: number;
}

/** The newest PDF under ~/work, if there is one. */
export async function findNewestPdf(sandbox: Sandbox): Promise<RecentPdf | undefined> {
    const found = await execInSandbox(sandbox, {
        cmd: 'bash',
        args: [
            '-c',
            'find . \\( -name node_modules -o -name .git \\) -prune -o ' +
                "-name '*.pdf' -type f -printf '%T@ %p\\n' | sort -rn",
        ],
        cwd: WORK_DIR,
        timeoutMs: 60_000,
    });
    if (!found.ok) return undefined;

    for (const line of found.stdout.split('\n')) {
        const space = line.indexOf(' ');
        if (space < 0) continue;
        const rel = line.slice(space + 1).replace(/^\.\//, '');
        // Held to the same character class as a path typed on the command line.
        if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(rel) || rel.split('/').includes('..')) continue;
        return { rel, mtimeMs: Number(line.slice(0, space)) * 1000 };
    }
    return undefined;
}

/**
 * Serves one file and nothing else: a fresh directory holding a symlink to the
 * PDF, so the rest of ~/work is not reachable through the forward, and a
 * rebuilt PDF is picked up by a browser refresh.
 *
 * Held in the foreground of the exec, like the trace viewer. Every value
 * reaches the command through the environment, never as shell syntax.
 */
export async function startPdfServer(sandbox: Sandbox, pdf: string, port: number): Promise<Viewer> {
    const handle = await sandbox.execStreamWith('bash', b => b
        .args([
            '-c',
            'dir=$(mktemp -d) && trap \'rm -rf "$dir"\' EXIT && ' +
            `ln -s "$SEU_PDF" "$dir/${SERVED_NAME}" && ` +
            'python3 -m http.server "$SEU_PORT" --bind 127.0.0.1 --directory "$dir"',
        ])
        .user('seu')
        .cwd(WORK_DIR)
        .envs({ SEU_PDF: `${WORK_DIR}/${pdf}`, SEU_PORT: String(port) }),
    );
    return watchProcess(handle);
}
