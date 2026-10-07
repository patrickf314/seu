// The base image: hashed, built on the host with Docker, then imported into
// microsandbox's image store. Port of seu_image_tag / seu_image_loaded and the
// base-image step of lib/cmd-build.sh.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInherit, runOk } from '../../host.ts';
import { LOG } from '../../common/log.ts';
import { die } from '../../common/error.ts';
import type { SeuConfig } from '../../config/config.ts';
import { SEU_ROOT } from '../../config/project.ts';
import { sdk } from '../../microsandbox/microsandboxSdk.ts';

/** Everything that goes into the image, so `start` can skip a rebuild. */
const IMAGE_INPUTS = [
    'vm/Dockerfile',
    'vm/dockerd-run.sh',
    'vm/session-init.sh',
    'vm/claude-settings.json',
];

/**
 * `<name>:<hash of the inputs>`. Only files that actually exist are hashed: a
 * project without a mise config is legitimate.
 */
export function imageTag(config: SeuConfig): string {
    const files = IMAGE_INPUTS.map((f) => join(SEU_ROOT, f));
    if (config.image.miseToml) files.push(config.image.miseToml);

    const h = createHash('sha256');
    for (const f of files) {
        if (!existsSync(f)) die(`missing image input: ${f}`);
        h.update(readFileSync(f));
    }
    return `${config.image.tag}:${h.digest('hex').slice(0, 12)}`;
}

/**
 * True when exactly this reference is in microsandbox's image store.
 *
 * Must match the FULL reference, name included: the hash covers only the image
 * inputs, which are identical across worktrees of the same repo, so a hash-only
 * test matches a sibling worktree's image. Sandbox creation would then be
 * handed a name that is not in the store and silently fall back to pulling it
 * from docker.io -- which fails with "Not authorized".
 */
export async function imageLoaded(reference: string): Promise<boolean> {
    const { Image } = await sdk();
    const images = await Image.list();
    return images.some((i) => i.reference === reference);
}

/**
 * Build the base image on the host and import it into microsandbox.
 *
 * The build context is staged: the vm/ files plus the repo's own mise config,
 * so the image toolchain always matches what the project's build validates.
 */
export async function buildBaseImage(
    tag: string,
    config: SeuConfig,
    stateDir: string,
    projectRoot: string,
): Promise<void> {
    const ctx = mkdtempSync(join(tmpdir(), 'seu-ctx-'));
    try {
        for (const f of ['Dockerfile', 'dockerd-run.sh', 'session-init.sh', 'claude-settings.json']) {
            copyFileSync(join(SEU_ROOT, 'vm', f), join(ctx, f));
        }

        const mise = config.image.miseToml;
        copyFileSync(mise, join(ctx, 'mise.toml'));
        LOG.debug(`toolchain from ${mise.startsWith(`${projectRoot}/`) ? mise.slice(projectRoot.length + 1) : mise}`);

        const args = ['build', '--provenance=false', '--sbom=false', '--platform', 'linux/arm64', '-t', tag, ctx];
        if ((await runInherit('docker', args)) !== 0) {
            die('base image build failed');
        }
        LOG.ok(`Base image built: ${tag}`);

        const tar = join(stateDir, 'base-image.tar');
        try {
            await runOk('docker', ['save', '-o', tar, tag], 'docker save failed');
            const { Image } = await sdk();
            await Image.load(tar, { tag });
        } finally {
            rmSync(tar, { force: true });
        }
        LOG.ok(`Base image ${tag} loaded into microsandbox`);
    } finally {
        rmSync(ctx, { recursive: true, force: true });
    }
}
