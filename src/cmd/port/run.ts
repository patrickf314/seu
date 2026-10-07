// The `seu port` flow: start, list and drop SSH tunnels into the session.
// The tunnels themselves are src/network/forward.ts.
//
// Kept apart from the command const in src/cmd/port.ts so that loading the
// command set does not load the microsandbox SDK.

import { LOG } from '../../common/log.ts';
import { die } from '../../common/error.ts';
import { loadConfig } from '../../config/config.ts';
import { type Instance, resolveInstance, resolveProject } from '../../config/project.ts';
import { requireSession, sessionStatus } from '../../session.ts';
import { sessionSandboxName } from '../../sandbox.ts';
import {
    forwardUp,
    listForwards,
    parsePort,
    parsePortSpec,
    type PortSpec,
    prepareTunnels,
    startForward,
    stopAllForwards,
    stopForward,
} from '../../network/forward.ts';

interface PortOptions {
    name: string | undefined;
    readonly specs: string[];
    readonly stops: number[];
    stopAll: boolean;
    list: boolean;
}

function parseArgs(argv: string[]): PortOptions {
    const opts: PortOptions = { name: undefined, specs: [], stops: [], stopAll: false, list: false };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--stop': {
                const port = argv[++i];
                if (port === undefined) die('--stop needs a host port');
                opts.stops.push(parsePort(port));
                break;
            }
            // An option rather than a leading positional: a spec is a
            // positional too, and `8080` is a perfectly good SEU name.
            case '--name':
            case '-n': {
                const name = argv[++i];
                if (name === undefined) die(`${arg} needs a SEU name`);
                opts.name = name;
                break;
            }
            case '--stop-all':
                opts.stopAll = true;
                break;
            case '--list':
            case '-l':
                opts.list = true;
                break;
            default:
                if (arg.startsWith('-')) die(`unknown option for port: ${arg}`);
                opts.specs.push(arg);
        }
    }
    return opts;
}

export async function run(argv: string[]): Promise<void> {
    const opts = parseArgs(argv);
    const project = await resolveProject();
    const instance = resolveInstance(project, opts.name);

    if (opts.stopAll) return stopAll(instance);
    if (opts.stops.length > 0) return stop(instance, opts.stops);
    if (opts.list) return await report(instance);

    // A bare `seu port` forwards the project's configured ports, and only
    // lists when there are none.
    const raw = opts.specs.length > 0 ? opts.specs : loadConfig(project).ports;
    if (raw.length === 0) return await report(instance);

    // Every spec first, so a typo in the last one does not leave half the
    // forwards up.
    const specs = raw.map(parsePortSpec);

    // Only the tunnels need the sandbox; the SDK is used to guarantee it is
    // running, and `msb ssh serve` does the rest by name.
    await requireSession(instance);
    const tunnels = await prepareTunnels(sessionSandboxName(instance));

    LOG.step(`Forwarding into ${tunnels.sandbox}`);
    let up = 0;
    for (const spec of specs) {
        if (await startForward(instance, tunnels, spec)) up++;
    }

    if (up > 0) LOG.info('forwards live until `seu port --stop <port>` or the session stops');
    if (up < specs.length) die('not every forward came up');
}

function stopAll(instance: Instance): void {
    LOG.step('Stopping every forward');
    const active = listForwards(instance);
    for (const forward of active) LOG.info(describe(forward));

    stopAllForwards(instance);
    if (active.length > 0) {
        LOG.ok('stopped');
    } else {
        LOG.info('none were active');
    }
}

function stop(instance: Instance, ports: number[]): void {
    LOG.step('Stopping forwards');
    for (const port of ports) {
        const wasUp = forwardUp(instance, port);
        // Unconditionally, even when nothing was up: that is also what clears
        // the record of a tunnel whose ssh has already died.
        stopForward(instance, port);
        if (wasUp) {
            LOG.ok(`host port ${port} released`);
        } else {
            LOG.info(`host port ${port} was not forwarded`);
        }
    }
}

/**
 * The only mode that works on a stopped session -- and the one that says so,
 * since a stopped session is the usual reason a forward you remember is gone.
 */
async function report(instance: Instance): Promise<void> {
    LOG.step(`Forwards for ${instance.name}`);

    const active = listForwards(instance);
    for (const forward of active) LOG.info(`${describe(forward)}  pid ${forward.pid}`);
    if (active.length > 0) return;

    LOG.info("none -- e.g. `seu port 8080:8080`, or list defaults under `ports` in .seu/config.json");
    const status = await sessionStatus(instance);
    if (status !== 'running') LOG.info(`${sessionSandboxName(instance)} is ${status}`);
}

const describe = (spec: PortSpec): string => `${`${spec.bind}:${spec.host}`.padEnd(21)} -> vm:${spec.guest}`;
