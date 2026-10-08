import { sdk } from './sdk.ts';
import type { Volume, VolumeHandle } from 'microsandbox';
import { die } from '../common/error.ts';
import { LOG } from '../common/log.ts';
import { dirname, join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { execOnHost } from '../host/exec.ts';

export const VOLUME_SIZE_MIB = 20 * 1024;

async function volumeHandle(name: string): Promise<VolumeHandle | undefined> {
    const { Volume } = await sdk();
    return (await Volume.list()).find((v) => v.name === name);
}

export async function volumeExists(name: string): Promise<boolean> {
    return (await volumeHandle(name)) !== undefined;
}

/**
 * Labels of a volume, or undefined when there is no such volume.
 */
export async function volumeLabels(name: string): Promise<Record<string, string> | undefined> {
    const handle = await volumeHandle(name);
    return handle === undefined ? undefined : Object.fromEntries(handle.labels);
}

/**
 * A fresh disk volume of the standard size.
 * Fails if the name is taken.
 */
export async function createVolume(name: string, labels: Record<string, string> = {}): Promise<Volume> {
    const { Volume } = await sdk();
    const builder = Volume.builder(name)
        .disk()
        .size(VOLUME_SIZE_MIB);

    for (const [key, value] of Object.entries(labels)) {
        builder.label(key, value);
    }

    return await builder.create();
}

/**
 * Make `target` a copy of `source`, which must exist and must not be mounted.
 */
export async function cloneVolume(source: string, target: string, labels: Record<string, string> = {}): Promise<Volume> {
    const targetVolume = await createVolume(target, labels);
    const from = join(dirname(targetVolume.path), source, 'disk.raw');
    const to = join(targetVolume.path, 'disk.raw');
    if (!existsSync(from)) {
        die(`no disk image for volume ${source} at ${from}`);
    }

    rmSync(to, { force: true });
    const cloneResult = await execOnHost({ cmd: 'cp', args: ['-c', from, to] });
    if (cloneResult.ok) {
        return targetVolume;
    }

    LOG.warn('this filesystem cannot clone files; copying the volume in full instead');
    rmSync(to, { force: true });
    const copyResult = await execOnHost({ cmd: 'cp', args: [from, to] });
    if (copyResult.code !== 0) {
        die(`could not copy volume ${source} to ${target}: ${copyResult.stderr.trim()}`);
    }

    return targetVolume;
}

/**
 * Remove a named volume. False when there was none.
 */
export async function removeVolume(name: string): Promise<boolean> {
    const handle = await volumeHandle(name);
    if (handle === undefined) {
        return false;
    }

    const { Volume } = await sdk();
    try {
        await Volume.remove(name);
        return true;
    } catch (err) {
        die(`could not remove ${name}: ${(err as Error).message}`);
    }
}
