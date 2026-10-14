import { die } from './error.ts';
import { WORK_DIR } from './constants.ts';

/**
 * A path inside ~/work. It is interpolated into a command that runs in the VM,
 * so it is held to an explicit character class -- the same one the profile's
 * own paths are -- rather than quoted and hoped for.
 */
export function guestPath(raw: string, what: string): string {
    const rel = raw.replace(new RegExp(`^${WORK_DIR}/`), '').replace(/^\.\//, '');
    if (rel.startsWith('/')) {
        die(`the ${what} path must be relative to ${WORK_DIR}: ${raw}`);
    }

    if (rel.split('/').includes('..')) {
        die(`the ${what} path must not contain '..': ${raw}`);
    }

    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(rel)) {
        die(`not a usable ${what} path: ${raw}`);
    }
    return rel;
}
