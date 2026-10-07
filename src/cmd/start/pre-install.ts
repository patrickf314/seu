// The pre-install phase of `seu start`: everything `image.pre-install` in
// .seu/config.json asks for, fetched into the named volume while the install
// sandbox still has egress.
//
// This is the whole point of having an install sandbox at all. A session has no
// network, so an image that is not in /seu/docker and an artifact that is not
// in /seu/m2 by the time this returns is simply not available in the session --
// it fails there as a pull timeout or an "artifact has not been downloaded from
// it before", far from the config line that forgot to name it. Hence: every
// step that fails is reported, and a single failure fails the start.

import type { Sandbox } from 'microsandbox';
import type { PreInstallStep } from '../../config/config.ts';
import { LOG } from '../../common/log.ts';
import { die } from '../../common/error.ts';
import { exec, SRC_MOUNT } from '../../sandbox.ts';

const COMPOSE_TIMEOUT_MS = 2 * 60_000;
const PULL_TIMEOUT_MS = 20 * 60_000;
const MAVEN_TIMEOUT_MS = 20 * 60_000;

/**
 * Run every step, in declaration order.
 *
 * Steps are NOT run in parallel: `mvn dependency:get` and `docker pull` both
 * write into the same volume, the order in the config is the order the author
 * reasoned about, and a serial log is the one that says which line is slow.
 */
export async function runPreInstall(sandbox: Sandbox, steps: readonly PreInstallStep[]): Promise<void> {
    // Across the whole run, not per step: two compose files naming the same
    // postgres is the normal case, and the second pull is pure wall-clock.
    const pulled = new Set<string>();
    const failures: string[] = [];

    for (const step of steps) {
        switch (step.type) {
            case 'docker-compose': {
                LOG.step(`Pulling the images of ${step.compose}`);
                for (const image of await composeImages(sandbox, step.compose)) {
                    await pull(sandbox, image, pulled, failures);
                }
                break;
            }
            case 'docker': {
                LOG.step(`Pulling ${step.image}`);
                await pull(sandbox, step.image, pulled, failures);
                break;
            }
            case 'maven': {
                LOG.step(`Resolving ${step.artifact}`);
                await resolveArtifact(sandbox, step.artifact, failures);
                break;
            }
        }
    }

    if (failures.length > 0) {
        die(
            `${failures.length} pre-install step(s) failed -- the session has no network, ` +
            `so anything missing now stays missing:\n    ${failures.join('\n    ')}`,
        );
    }
}

/**
 * The images a compose file names, as compose itself resolves them --
 * variables substituted, `extends` followed, defaults filled in.
 *
 * The resolved model rather than `docker compose pull`, for two reasons: it
 * buys the per-image reporting below, and it is the only way to tell a service
 * that is PULLED from one that is BUILT. `--images` prints both, and the name
 * it invents for a built service (`<project>-<service>`) exists in no registry,
 * so pulling the list it prints fails on a perfectly correct compose file.
 */
async function composeImages(sandbox: Sandbox, file: string): Promise<string[]> {
    const result = await exec(sandbox, {
        cmd: 'bash',
        // `--profile '*'`: a service behind a profile is still a service
        // somebody will start one day, and the session has no second chance to
        // pull it. Compose would leave them out of the default model.
        args: ['-lc', 'docker compose --profile "*" -f "$SEU_COMPOSE_FILE" config --format json'],
        user: 'seu',
        env: { SEU_COMPOSE_FILE: `${SRC_MOUNT}/${file}` },
        timeoutMs: COMPOSE_TIMEOUT_MS,
    });
    if (!result.ok) {
        const detail = (result.stderr || result.stdout).trim().split('\n').slice(-5).join('\n    ');
        die(`could not read the images out of ${file}\n    ${detail}`);
    }

    let model: { services?: Record<string, { image?: unknown; build?: unknown }> };
    try {
        model = JSON.parse(result.stdout) as typeof model;
    } catch (err) {
        return die(`${file}: docker compose did not return a usable model\n    ${(err as Error).message}`);
    }

    const images: string[] = [];
    for (const [name, service] of Object.entries(model.services ?? {})) {
        if (service.build !== undefined) {
            LOG.debug(`${name} is built, not pulled -- skipped`);
        } else if (typeof service.image === 'string' && service.image !== '') {
            images.push(service.image);
        }
    }

    if (images.length === 0) LOG.warn(`${file} names no images to pull`);
    return images;
}

async function pull(sandbox: Sandbox, image: string, pulled: Set<string>, failures: string[]): Promise<void> {
    if (pulled.has(image)) {
        LOG.debug(`${image} already pulled`);
        return;
    }
    pulled.add(image);

    const result = await exec(sandbox, {
        // The reference goes through the environment rather than the command
        // line: the schema already rejects anything that is not an image
        // reference, and this way nothing in the repository's config can reach
        // a shell as syntax.
        cmd: 'bash',
        args: ['-lc', 'docker pull -q "$SEU_IMAGE"'],
        user: 'seu',
        env: { SEU_IMAGE: image },
        timeoutMs: PULL_TIMEOUT_MS,
    });

    if (result.ok) {
        LOG.ok(image);
    } else {
        LOG.error(image);
        report(result.stderr || result.stdout);
        failures.push(`docker pull ${image}`);
    }
}

/**
 * `dependency:get`, not a file copy: it resolves the artifact properly --
 * descriptors, parent POMs and transitives -- which is what a plugin invoked
 * from the command line in the session will go looking for.
 */
async function resolveArtifact(sandbox: Sandbox, artifact: string, failures: string[]): Promise<void> {
    const result = await exec(sandbox, {
        cmd: 'bash',
        args: ['-lc', 'mvn -B -q dependency:get -Dartifact="$SEU_ARTIFACT"'],
        user: 'seu',
        env: { SEU_ARTIFACT: artifact },
        timeoutMs: MAVEN_TIMEOUT_MS,
    });

    if (result.ok) {
        LOG.ok(artifact);
    } else {
        LOG.error(artifact);
        report(result.stderr || result.stdout);
        failures.push(`mvn dependency:get ${artifact}`);
    }
}

/** The last few lines of a failure, indented. A swallowed one is unreadable later. */
function report(output: string): void {
    for (const line of output.trim().split('\n').slice(-5)) LOG.debug(`    ${line}`);
}
