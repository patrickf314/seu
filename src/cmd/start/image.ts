// The base image: hashed, built on the host with Docker, then imported into
// microsandbox's image store. Port of seu_image_tag / seu_image_loaded and the
// base-image step of lib/cmd-build.sh.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInherit, runOk } from '../../host.ts';
import { LOG } from '../../common/log.ts';
import { die } from '../../common/error.ts';
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
 * One repository for every project: nothing project-specific goes into the
 * image any more -- the toolchain is installed into each project's template
 * (src/cmd/start/toolchain.ts) -- so every project runs on the same image.
 */
const IMAGE_REPOSITORY = 'seu';

/** `seu:<hash of the inputs>`. */
export function imageTag(): string {
    const h = createHash('sha256');
    for (const f of IMAGE_INPUTS.map((f) => join(SEU_ROOT, f))) {
        if (!existsSync(f)) die(`missing image input: ${f}`);
        h.update(readFileSync(f));
    }
    return `${IMAGE_REPOSITORY}:${h.digest('hex').slice(0, 12)}`;
}

/**
 * True when exactly this reference is in microsandbox's image store.
 *
 * Must match the FULL reference, name included: a hash-only test would match
 * an image some older seu loaded under another name. Sandbox creation would
 * then be handed a name that is not in the store and silently fall back to
 * pulling it from docker.io -- which fails with "Not authorized".
 */
export async function imageLoaded(reference: string): Promise<boolean> {
    const { Image } = await sdk();
    const images = await Image.list();
    return images.some((i) => i.reference === reference);
}

/**
 * Build the base image on the host and import it into microsandbox.
 *
 * The build context is staged from the vm/ files alone.
 */
export async function buildBaseImage(tag: string, stateDir: string): Promise<void> {
    const ctx = mkdtempSync(join(tmpdir(), 'seu-ctx-'));
    try {
        for (const f of ['Dockerfile', 'dockerd-run.sh', 'session-init.sh', 'claude-settings.json']) {
            copyFileSync(join(SEU_ROOT, 'vm', f), join(ctx, f));
        }

        const args = ['build', '--provenance=false', '--sbom=false', '--platform', 'linux/arm64', '-t', tag, ctx];
        if ((await runInherit('docker', args)) !== 0) {
            die('base image build failed');
        }
        LOG.ok(`Base image built: ${tag}`);

        mkdirSync(stateDir, { recursive: true });
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
