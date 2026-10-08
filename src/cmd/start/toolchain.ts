// The `mise` install step of `seu start`: the project's mise.toml, installed
// into the template volume while the install sandbox still has egress.
//
// The image carries only mise itself. Its data and config dirs point into the
// named volume (/seu/mise, see vm/Dockerfile), so what is installed here is part
// of the template -- and of every SEU cloned from it -- and the image stays the
// same for every project.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Sandbox } from 'microsandbox';
import { LOG } from '../../common/log.ts';
import { die } from '../../common/error.ts';
import type { SeuConfig } from '../../config/config.ts';
import { VOLUME_MOUNT } from '../../sandbox.ts';
import { execInSandbox } from '../../msb/exec.ts';

/** A JDK download on a slow line, times a few tools. */
const MISE_TIMEOUT_MS = 30 * 60_000;

/**
 * What a template's toolchain was installed from, for its label: a hash of the
 * mise.toml, or `none`. A changed file is a stale template, not a stale image.
 */
export function toolchainFingerprint(config: SeuConfig): string {
    const mise = config.install.find((s) => s.type === 'mise')?.toml;
    if (mise === undefined) {
        return 'none';
    }

    return createHash('sha256')
        .update(readFileSync(mise))
        .digest('hex')
        .slice(0, 12);
}

/**
 * Write the project's mise.toml as mise's global config in the volume, then
 * install it. Global rather than the copy in /work: it has to apply wherever a
 * shim is called from, and /work moves on to other branches.
 */
export async function installToolchain(sandbox: Sandbox, mise: string): Promise<void> {
    LOG.step('Installing the toolchain (mise)');
    const result = await execInSandbox(sandbox, {
        // Through the environment, not a heredoc: the file is the project's,
        // and none of it should have to survive a shell.
        cmd: 'bash',
        args: [
            '-lc',
            `set -e
             mkdir -p "$MISE_CONFIG_DIR"
             printf '%s' "$SEU_MISE_TOML" > "$MISE_CONFIG_DIR/config.toml"
             mise trust "$MISE_CONFIG_DIR/config.toml"
             mise install
             mise reshim`,
        ],
        // Away from /work, so only the global config is in play.
        cwd: VOLUME_MOUNT,
        env: { SEU_MISE_TOML: readFileSync(mise, 'utf8') },
        timeoutMs: MISE_TIMEOUT_MS,
        stream: true,
    });

    if (!result.ok) {
        die(
            result.timedOut
                ? `mise install did not finish within ${MISE_TIMEOUT_MS / 60_000} minutes`
                : `mise install failed (exit ${result.code})`,
        );
    }
    LOG.ok('toolchain installed');
}
