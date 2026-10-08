// Borrowing the developer's own Maven repository.
//
// `seu start` used to download a Maven world you already have on disk. Instead,
// ~/.m2/repository is mounted READ-ONLY at /host-m2 in the sandboxes that have a
// network, and declared there as a `file://` repository, ahead of the real
// remotes.
//
// It is a resolution SOURCE, never a seed. Copying is not an option -- a working
// developer's repository is tens of gigabytes against a 20 GiB volume, and
// virtiofs is slow enough that a bulk copy would lose to a plain download. As a
// `file://` remote, Maven takes exactly the artifacts this project asks for and
// copies them into ~/.m2, so the session stays self-contained with no host
// mount. Anything /host-m2 cannot serve falls through to the real remotes.
//
// It also removes the reason credentials were ever needed in here: an artifact
// from a private repository is already in your ~/.m2/repository, so the sandbox
// resolves it from a local file instead of authenticating to anything.

import type { Sandbox } from 'microsandbox';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HOST_REPOSITORY_MOUNT } from '../msb/sandbox.ts';
import { LOG } from '../common/log.ts';
import { SEU_ROOT } from '../config/project.ts';
import { execInSandbox } from '../msb/exec.ts';

const SETTINGS_PATH = '~/.m2/settings.xml';

/** The repository id the generated settings declares. */
const REPOSITORY_ID = 'seu-host-m2';

/**
 * The host repository to lend this run, or undefined when there is none to lend.
 *
 * `SEU_HOST_M2` relocates it; `SEU_USE_HOST_M2=0` and `--no-host-m2` turn it
 * off. A developer who has never run Maven on this machine simply downloads
 * everything, which is the old behaviour and not an error.
 *
 * The path is resolved through symlinks because a mount source has to be a real
 * path: a symlinked one fails at boot with "Not a directory".
 */
export function hostRepository(enabled: boolean): string | undefined {
    if (!enabled) {
        LOG.debug('host Maven repository disabled');
        return undefined;
    }

    if (process.env['SEU_USE_HOST_M2'] === '0') {
        LOG.debug('host Maven repository disabled via SEU_USE_HOST_M2=0');
        return undefined;
    }

    const path = process.env['SEU_HOST_M2'] ?? join(homedir(), '.m2', 'repository');
    if (!existsSync(path) || !statSync(path).isDirectory()) {
        LOG.debug(`${path} does not exist -- everything will be downloaded`);
        return undefined;
    }

    const real = realpathSync(path);
    LOG.ok(`${real} -> ${HOST_REPOSITORY_MOUNT} (read-only)`);
    return real;
}

/**
 * Declare /host-m2 to the guest's Maven, by writing the settings it reads.
 *
 * Call before anything resolves. The document is generated rather than taken
 * from the host's own settings.xml, which seu never reads: that file is where
 * credentials live, and nothing here needs one.
 */
export async function declareHostRepository(sandbox: Sandbox): Promise<void> {
    await writeSettings(
        sandbox,
        settingsDocument('host-repository-settings.xml', { REPOSITORY_ID, HOST_REPOSITORY_MOUNT }),
    );
    LOG.ok(`${REPOSITORY_ID} declared in ${SETTINGS_PATH}`);
}

/**
 * Hand the repository over to the offline session.
 *
 * Two things have to happen, and neither is housekeeping:
 *
 * Maven records each artifact's origin in `_remote.repositories`, and OFFLINE it
 * refuses an artifact whose recorded origin is not among the repositories
 * currently in play. Half the repository now claims to come from `seu-host-m2`,
 * a `file://` URL that exists only in this sandbox, so without deleting the
 * tracking files the session cannot resolve what was just fetched for it -- it
 * fails with "has not been downloaded from it before".
 *
 * And the settings themselves must stop naming /host-m2, which the session has
 * no mount for. It gets `<offline>true</offline>` instead, which is the truth
 * about a sandbox with no egress and makes Maven say so immediately rather than
 * timing out against a remote it cannot reach.
 */
export async function sealForOffline(sandbox: Sandbox): Promise<void> {
    const result = await execInSandbox(sandbox, {
        cmd: 'bash',
        args: [
            '-lc',
            `find ~/.m2 -type f \\( -name _remote.repositories \\
                                   -o -name '*.lastUpdated' \\
                                   -o -name resolver-status.properties \\
                                   -o -name '*.part' -o -name '*.part.lock' \\) -delete 2>/dev/null
             exit 0`,
        ],
        timeoutMs: 10 * 60_000,
    });
    if (!result.ok) LOG.warn('could not clear the Maven resolution tracking files');

    await writeSettings(sandbox, settingsDocument('offline-settings.xml'));
    LOG.ok('Maven repository sealed for the offline session');
}

async function writeSettings(sandbox: Sandbox, document: string): Promise<void> {
    const result = await execInSandbox(sandbox, {
        // Through the environment, not a heredoc: the document has quotes and
        // newlines in it and none of that should have to survive a shell.
        cmd: 'bash',
        args: [
            '-lc',
            `mkdir -p "$(dirname "${SETTINGS_PATH}")" && printf '%s' "$SEU_SETTINGS_XML" > "${SETTINGS_PATH}"`,
        ],
        env: { SEU_SETTINGS_XML: document },
        timeoutMs: 60_000,
    });
    if (!result.ok) LOG.warn(`could not write ${SETTINGS_PATH}`);
}

/**
 * A settings document from resources/maven, with its `{{NAME}}` placeholders
 * filled in. Read at runtime rather than bundled, so the same path works from
 * dist/cli.js and from `node src/cli.ts`.
 */
function settingsDocument(file: string, values: Record<string, string> = {}): string {
    const template = readFileSync(join(SEU_ROOT, 'resources', 'maven', file), 'utf8');
    return template.replace(/\{\{(\w+)}}/g, (placeholder, name: string) => values[name] ?? placeholder);
}
