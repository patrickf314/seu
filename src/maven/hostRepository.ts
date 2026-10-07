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
// copies them into /seu/m2, so the session stays self-contained with no host
// mount. Anything /host-m2 cannot serve falls through to the real remotes.
//
// It also removes the reason credentials were ever needed in here: an artifact
// from a private repository is already in your ~/.m2/repository, so the sandbox
// resolves it from a local file instead of authenticating to anything.

import type { Sandbox } from 'microsandbox';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exec, HOST_REPOSITORY_MOUNT } from '../sandbox.ts';
import { LOG } from '../common/log.ts';

/** The guest path Maven reads settings from. ~/.m2 is a symlink to /seu/m2. */
const SETTINGS_PATH = '/home/seu/.m2/settings.xml';

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
    await writeSettings(sandbox, HOST_REPOSITORY_SETTINGS);
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
    const result = await exec(sandbox, {
        cmd: 'bash',
        args: [
            '-lc',
            `find /seu/m2 -type f \\( -name _remote.repositories \\
                                   -o -name '*.lastUpdated' \\
                                   -o -name resolver-status.properties \\
                                   -o -name '*.part' -o -name '*.part.lock' \\) -delete 2>/dev/null
             exit 0`,
        ],
        user: 'seu',
        timeoutMs: 10 * 60_000,
    });
    if (!result.ok) LOG.warn('could not clear the Maven resolution tracking files');

    await writeSettings(sandbox, OFFLINE_SETTINGS);
    LOG.ok('Maven repository sealed for the offline session');
}

async function writeSettings(sandbox: Sandbox, document: string): Promise<void> {
    const result = await exec(sandbox, {
        // Through the environment, not a heredoc: the document has quotes and
        // newlines in it and none of that should have to survive a shell.
        cmd: 'bash',
        args: [
            '-lc',
            `mkdir -p "$(dirname "${SETTINGS_PATH}")" && printf '%s' "$SEU_SETTINGS_XML" > "${SETTINGS_PATH}"`,
        ],
        user: 'seu',
        env: { SEU_SETTINGS_XML: document },
        timeoutMs: 60_000,
    });
    if (!result.ok) LOG.warn(`could not write ${SETTINGS_PATH}`);
}

/**
 * Releases only, and an additional repository rather than a mirror.
 *
 * A `file://` local repository is a valid Maven REMOTE for releases and nothing
 * more: it carries `maven-metadata-<repoid>.xml`, not the remote-layout metadata
 * that snapshot and version-range resolution read. Declared as a mirror it would
 * swallow those lookups and fail them; declared with snapshots enabled it would
 * answer them wrongly. As an extra repository with snapshots off, whatever it
 * cannot serve falls through to the real remotes untouched.
 */
const HOST_REPOSITORY_SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<!--
  Generated by seu. The host's ~/.m2/repository is mounted read-only at
  ${HOST_REPOSITORY_MOUNT} and offered here as a resolution source, so this
  sandbox copies out what the project needs instead of downloading it again.

  Replaced with an offline-only settings.xml before the session starts: this
  repository does not exist there.
-->
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">
  <profiles>
    <profile>
      <id>${REPOSITORY_ID}</id>
      <repositories>
        <repository>
          <id>${REPOSITORY_ID}</id>
          <url>file://${HOST_REPOSITORY_MOUNT}</url>
          <releases><enabled>true</enabled><updatePolicy>never</updatePolicy></releases>
          <snapshots><enabled>false</enabled></snapshots>
        </repository>
      </repositories>
      <pluginRepositories>
        <pluginRepository>
          <id>${REPOSITORY_ID}</id>
          <url>file://${HOST_REPOSITORY_MOUNT}</url>
          <releases><enabled>true</enabled><updatePolicy>never</updatePolicy></releases>
          <snapshots><enabled>false</enabled></snapshots>
        </pluginRepository>
      </pluginRepositories>
    </profile>
  </profiles>
  <activeProfiles>
    <activeProfile>${REPOSITORY_ID}</activeProfile>
  </activeProfiles>
</settings>
`;

const OFFLINE_SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<!--
  Generated by seu. The session has no egress, so Maven is told as much: it
  resolves from the repository that seu start filled, and never
  waits on a remote it cannot reach.
-->
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">
  <offline>true</offline>
</settings>
`;
