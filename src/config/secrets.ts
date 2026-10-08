// `secrets` from the project profile: 1Password references, resolved on the
// host with the `op` CLI.
//
// Resolved every time a shell is entered and handed to that shell's
// environment only -- never written to the sandbox's disk, the volume or its
// config, so a stopped session holds nothing and a rotated item is picked up by
// the next `seu shell`.

import { execOnHost } from '../host/exec.ts';
import { LOG } from '../common/log.ts';
import type { SeuConfig } from './config.ts';

/**
 * The profile's secrets, read from 1Password. A secret that cannot be read is
 * a warning, not a refusal: the shell is still usable without it, the same way
 * a denied Keychain prompt only means starting logged out.
 */
export async function resolveSecrets(config: SeuConfig): Promise<Record<string, string>> {
    const entries = Object.entries(config.secrets);
    if (entries.length === 0) return {};

    LOG.step('Secrets');
    const resolved: Record<string, string> = {};
    for (const [name, reference] of entries) {
        // The reference is printed on purpose: the profile comes from the
        // repository, and which 1Password items it asks for is yours to see.
        try {
            const r = await execOnHost({ cmd: 'op', args: ['read', '--no-newline', reference] });
            if (r.code === 0 && r.stdout) {
                resolved[name] = r.stdout;
                LOG.ok(`${name} <- ${reference}`);
            } else {
                LOG.warn(`${name}: could not read ${reference}`);
                const detail = r.stderr.trim().split('\n').at(-1);
                if (detail) LOG.debug(detail);
            }
        } catch (err) {
            LOG.warn(`${name}: ${(err as Error).message} -- install the 1Password CLI to resolve ${reference}`);
        }
    }
    return resolved;
}
