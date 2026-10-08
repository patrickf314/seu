import type { Sandbox } from 'microsandbox';
import type { InstallStep } from '../../config/config.ts';
import { LOG } from '../../common/log.ts';
import { die } from '../../common/error.ts';
import { SRC_MOUNT, WORK_DIR } from '../../sandbox.ts';
import { installToolchain } from './toolchain.ts';
import { execInSandbox } from '../../msb/exec.ts';

const COMPOSE_TIMEOUT_MS = 2 * 60_000; // 2min
const PULL_TIMEOUT_MS = 20 * 60_000; // 20min
const MAVEN_TIMEOUT_MS = 20 * 60_000; // 20min
const SCRIPT_TIMEOUT_MS = 90 * 60_000; // 20min

/** The steps that need a docker daemon in the install sandbox. */
export function needsDocker(steps: readonly InstallStep[]): boolean {
    // A script gets it unconditionally, because a build command is opaque to
    // us, and the ones that want Docker (Testcontainers, buildpacks, a compose
    // file started by a test) fail in ways that point anywhere but at a
    // missing daemon.
    return steps.some((s) => s.type === 'docker' || s.type === 'docker-compose' || s.type === 'script');
}

/**
 * Run every step, in declaration order.
 *
 * Steps are NOT run in parallel: `mvn dependency:get` and `docker pull` both
 * write into the same volume, the order in the config is the order the author
 * reasoned about -- the mise step before anything that needs its JDK -- and a
 * serial log is the one that says which line is slow.
 *
 * A failed fetch does not stop the fetches after it, so one start reports all
 * of them; but they are settled before a mise or script step, which would
 * otherwise spend its time on a template that is already broken.
 */
export async function runInstall(sandbox: Sandbox, steps: readonly InstallStep[]): Promise<void> {
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
            case 'mise': {
                failOn(failures);
                await installToolchain(sandbox, step.toml);
                break;
            }
            case 'script': {
                failOn(failures);
                await runScript(sandbox, step.script);
                break;
            }
        }
    }

    failOn(failures);
}

function failOn(failures: readonly string[]): void {
    if (failures.length === 0) return;
    die(
        `${failures.length} install step(s) failed -- the session has no network, ` +
            `so anything missing now stays missing:\n    ${failures.join('\n    ')}`,
    );
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
    const result = await execInSandbox(sandbox, {
        cmd: 'bash',
        // `--profile '*'`: a service behind a profile is still a service
        // somebody will start one day, and the session has no second chance to
        // pull it. Compose would leave them out of the default model.
        args: ['-lc', 'docker compose --profile "*" -f "$SEU_COMPOSE_FILE" config --format json'],
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

    const result = await execInSandbox(sandbox, {
        // The reference goes through the environment rather than the command
        // line: the schema already rejects anything that is not an image
        // reference, and this way nothing in the repository's config can reach
        // a shell as syntax.
        cmd: 'bash',
        args: ['-lc', 'docker pull -q "$SEU_IMAGE"'],
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
    const result = await execInSandbox(sandbox, {
        cmd: 'bash',
        args: ['-lc', 'mvn -B -q dependency:get -Dartifact="$SEU_ARTIFACT"'],
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

async function runScript(sandbox: Sandbox, script: string): Promise<void> {
    LOG.step('Running install script');
    LOG.debug(`${WORK_DIR}$ ${script}`);
    warnOnRootWork(script);

    const result = await execInSandbox(sandbox, {
        // The script IS a shell command -- see ScriptStep in
        // src/config/config.ts. It runs as `seu`, in a sandbox that is
        // destroyed right after, and never on the host.
        cmd: 'bash',
        args: ['-lc', script],
        cwd: WORK_DIR,
        timeoutMs: SCRIPT_TIMEOUT_MS,
        stream: true,
    });

    if (!result.ok) {
        die(
            result.timedOut
                ? `install script did not finish within ${SCRIPT_TIMEOUT_MS / 60_000} minutes`
                : `install script failed (exit ${result.code})`,
        );
    }
    LOG.ok('install script finished');
}

/**
 * The install runs as `seu`, in a sandbox whose rootfs is thrown away. A step
 * that wants root is therefore wrong twice over, and the way it announces
 * itself -- a sudo password prompt on a VM with no password -- says neither.
 *
 * A warning rather than a refusal: the script is the project's business, and a
 * `docker run` of something that happens to contain the word apt-get is nobody
 * else's. But it names the fix, which is the part that is hard to guess.
 */
function warnOnRootWork(script: string): void {
    const needsRoot = /\b(sudo|apt-get|apt-key|install-deps)\b/.exec(script);
    if (needsRoot === null) return;

    LOG.warn(`the install script contains \`${needsRoot[0]}\`, which wants root`);
    LOG.warn('    this runs as `seu`, and anything outside /seu dies with this sandbox');
    LOG.warn('    system packages belong in the image (`image` in .seu/config.json)');
}

/**
 * The lines of a failure that say why, indented. A swallowed one is unreadable
 * later.
 *
 * Not simply the last few: mise's shims print a cache warning on every call
 * (its cache dir is root's, and these run as `seu`), and five of those are
 * exactly what used to be left of a Maven failure. Maven's own `[ERROR]` lines
 * are what says why, so they win when there are any.
 */
function report(output: string): void {
    const lines = output
        .trim()
        .split('\n')
        .filter((l) => l.trim() !== '' && !l.startsWith('mise WARN'));
    const errors = lines.filter((l) => l.startsWith('[ERROR]') && l.trim() !== '[ERROR]');
    for (const line of (errors.length > 0 ? errors : lines).slice(-8)) LOG.debug(`    ${line}`);
}
