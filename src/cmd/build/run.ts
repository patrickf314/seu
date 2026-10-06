// The `seu build` flow: build the base image, then fill the named volume with
// what `image.pre-install` in .seu/config.json asks for.
//
// Two phases, and the split is not cosmetic. The IMAGE is built on the host
// with Docker and holds the toolchain -- it is shared by every sandbox of this
// project. The PRE-INSTALL runs inside a throwaway sandbox with wide egress and
// writes into the named volume, which is the only thing that survives into the
// session; a sandbox's network policy cannot be changed after creation, so the
// session can never be the one doing this.
//
// Kept apart from the command const in src/cmd/build.ts so that loading the
// command set does not load the microsandbox SDK: `seu help` has to work on a
// checkout with no node_modules, and this module is only imported once a build
// actually starts.

import type { ExecHandle } from 'microsandbox';
import { type MicrosandboxSdk, sdk } from '../../microsandbox/microsandboxSdk.ts';
import { CONFIG_FILE, loadConfig, type PreInstallStep, type SeuConfig } from '../../config/config.ts';
import { succeeds } from '../../host.ts';
import { buildBaseImage, imageLoaded, imageTag } from './image.ts';
import { LOG } from '../../common/log.ts';
import { die } from '../../common/error.ts';
import { buildNetworkPolicy } from '../../network/net.ts';
import { type Project, resolveProject } from '../../config/project.ts';
import { runPreInstall, SRC_MOUNT } from './pre-install.ts';
import {
    bootstrapVolume,
    ensureVolume,
    RESOURCES,
    startDockerd,
    VOLUME_MOUNT,
    VOLUME_SIZE_MIB,
    volumeName,
    waitForAgent,
} from '../../sandbox.ts';

interface BuildOptions {
    rebuild: boolean;
}

function parseArgs(argv: string[]): BuildOptions {
    const opts: BuildOptions = { rebuild: false };

    for (const arg of argv) {
        switch (arg) {
            case '--rebuild':
                opts.rebuild = true;
                break;
            default:
                die(`unknown option for build: ${arg}`);
        }
    }
    return opts;
}

function validateMicroSandbox(resolveRuntime: MicrosandboxSdk['resolveRuntime']): void {
    try {
        const runtime = resolveRuntime();
        LOG.ok(`microsandbox runtime ${runtime.msbPath} (${runtime.origin})`);
    } catch (err) {
        die(`no usable microsandbox runtime: ${(err as Error).message}`);
    }
}

async function validateDocker() {
    if (!(await succeeds('docker', ['info']))) {
        die('host Docker is not reachable -- needed to build the base image');
    }
}

function validateConfigFile(config: SeuConfig) {
    if (config.file === undefined) {
        LOG.ok(`no ${CONFIG_FILE} -- using defaults`);
    } else {
        LOG.ok(`profile  ${CONFIG_FILE}`);
    }
}

async function buildImage(config: SeuConfig, opts: BuildOptions, project: Project) {
    const tag = imageTag(config);
    if (!opts.rebuild && (await imageLoaded(tag))) {
        LOG.ok(`${tag} already loaded (pass --rebuild to force)`);
    } else {
        await buildBaseImage(tag, config, project.stateDir, project.root);
    }
    return tag;
}

export async function run(argv: string[]): Promise<void> {
    // The SDK reads these when a sandbox is created, so this only has to happen
    // before the first call into it.
    // useSdkRuntime();
    const { resolveRuntime } = await sdk();

    const opts = parseArgs(argv);
    const project = await resolveProject();
    const config = loadConfig(project);

    LOG.step('Checking Preconditions');
    validateMicroSandbox(resolveRuntime);
    await validateDocker();
    LOG.ok(`Project Root ${project.root} (${project.slug})`);
    validateConfigFile(config);

    LOG.step('Building Base Image');
    const tag = await buildImage(config, opts, project);

    LOG.step('Pre-Install');
    const steps = config.image.preInstall;
    if (steps.length === 0) {
        LOG.debug(`nothing to pre-install -- add image.pre-install to ${CONFIG_FILE}`);
    } else {
        await preInstall(tag, project, steps);
    }

    LOG.step('Build complete');
}

/**
 * Boot the throwaway build sandbox, run the steps, tear it down.
 *
 * Only reached when there is something to do: a microVM boot plus a dockerd
 * start is about a minute, and a project that pre-installs nothing should not
 * pay it.
 */
async function preInstall(tag: string, project: Project, steps: readonly PreInstallStep[]): Promise<void> {
    const { Sandbox } = await sdk();

    LOG.step('Named volume');
    await ensureVolume(project.slug);

    LOG.step('Creating the build sandbox (wide network egress)');
    const networkPolicy = await buildNetworkPolicy();

    const sandbox = await Sandbox.builder(`seu-build-${project.slug}`)
        .image(tag)
        .pullPolicy('never')
        .replace()
        .cpus(RESOURCES.cpus)
        .memory(RESOURCES.memoryMiB)
        .rootDisk(RESOURCES.rootDiskMiB)
        .idleTimeout(RESOURCES.idleTimeoutSecs)
        .user('seu')
        .shell('/bin/bash')
        .network((n) => n.strict(false).policy(networkPolicy))
        .volume(VOLUME_MOUNT, (m) => m.namedWith(volumeName(project.slug), 'ensure-exists', 'disk', VOLUME_SIZE_MIB))
        .volume(SRC_MOUNT, (m) => m.bind(project.root).readonly())
        .create();

    LOG.ok(`Created VM for build phase`);

    let dockerd: ExecHandle | undefined = undefined;
    const teardown = async (): Promise<void> => {
        await dockerd?.kill().catch(() => {
        });
        dockerd = undefined;

        try {
            await sandbox.destroy({ timeoutMs: 60_000 });
        } catch {
            await sandbox.destroy({ force: true }).catch(() => {
            });
        }
        LOG.ok('Removed VM of build phase');
    };

    const onSignal = (): void => {
        void teardown().finally(() => process.exit(130));
    };

    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    try {
        await waitForAgent(sandbox);
        await bootstrapVolume(sandbox);

        // dockerd is the slow part of the boot; a profile that only resolves
        // Maven artifacts has no use for it.
        if (steps.some((s) => s.type === 'docker' || s.type === 'docker-compose')) {
            LOG.step('Starting dockerd in the build sandbox');
            dockerd = await startDockerd(sandbox);
        }

        await runPreInstall(sandbox, steps);
    } finally {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        await teardown();
    }
}
