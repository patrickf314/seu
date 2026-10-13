// The `seu playwright` flow: Playwright's trace viewer, run in the session and
// reached from the host over an ordinary `seu port` forward.
//
// The viewer is held exactly the way dockerd is (see startDockerd in
// src/sandbox.ts): in the foreground of an exec this process keeps open. A
// process backgrounded inside an exec dies with that exec's session, and an
// exec that leaves one behind never returns.
//
// Kept apart from the command const in src/cmd/playwright.ts so that loading
// the command set does not load the microsandbox SDK.

import { existsSync } from 'node:fs';
import type { Sandbox } from 'microsandbox';
import { LOG } from '../../common/log.ts';
import { die } from '../../common/error.ts';
import { type InstanceOptions, parseArgs } from '../../common/args.ts';
import { execOnHost } from '../../host/exec.ts';
import { type Instance, type Project, resolveInstance, resolveProject } from '../../config/project.ts';
import { CONFIG_FILE } from '../../config/config.ts';
import { resumeSession, sessionSandboxName } from '../../msb/session.ts';
import { WORK_DIR } from '../../common/constants.ts';
import {
    hostPortListening,
    parsePort,
    type PortSpec,
    prepareTunnels,
    startForward,
    stopForward,
} from '../../network/forward.ts';
import { execInSandbox } from '../../msb/exec.ts';
import { startViewer, waitForViewer } from '../../playwright/viewer.ts';
import { age, describeTrace, findRecentTraces, TRACES_DIR } from '../../playwright/traces.ts';

/** Playwright's own default for show-trace, and ten more after it. */
const FIRST_PORT = 9323;
const LAST_PORT = 9333;

interface TraceOptions {
    trace: string | undefined;
    port: number | undefined;
    pom: string | undefined;
    open: boolean;
    last: number;
}

export async function run(argv: string[]): Promise<number> {
    return trace(
        parseArgs<TraceOptions>(argv, {
            command: 'playwright',
            defaults: { trace: undefined, port: undefined, pom: undefined, open: true, last: 5 },
            flags: {
                '--port': (opts, value) => (opts.port = parsePort(value())),
                '--pom': (opts, value) => (opts.pom = guestPath(value(), 'pom')),
                '--last': (opts, value) => {
                    const raw = value();
                    const n = Number(raw);
                    if (!Number.isInteger(n) || n < 1 || n > 9) die(`--last takes a number from 1 to 9, got ${raw}`);
                    opts.last = n;
                },
                '--no-open': { open: false },
            },
            positional: (opts, arg) => {
                if (opts.trace !== undefined) die(`one trace at a time, got ${opts.trace} and ${arg}`);
                opts.trace = guestPath(arg, 'trace');
            }
        }),
    );
}

/**
 * A path inside ~/work. It is interpolated into a command that runs in the VM,
 * so it is held to an explicit character class -- the same one the profile's
 * own paths are -- rather than quoted and hoped for.
 */
function guestPath(raw: string, what: string): string {
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

async function trace(opts: TraceOptions & InstanceOptions): Promise<number> {
    if (opts.trace === undefined && !process.stdin.isTTY) {
        die('which trace? e.g. `seu playwright club/ui/target/trace.zip` (no terminal to pick one from)');
    }

    LOG.step('Metadata');
    const project = await resolveProject();
    const instance = resolveInstance(project, opts.name);
    const session = await resumeSession(instance);
    logMetadata(project, instance);

    LOG.step(`Playwright Trace in ${session.name}`);
    let trace = opts.trace;
    if (trace === undefined) {
        trace = await pickTrace(session.sandbox, session.name, opts.last);
    } else {
        await requireFile(session.sandbox, trace, 'trace');
    }
    LOG.ok(`       Trace: ${trace}`);

    LOG.step(`pom.xml`);
    let pom = opts.pom;
    if (pom === undefined) {
        pom = await guessPom(session.sandbox, trace);

        if (pom === undefined) {
            die('which module has Playwright on its classpath? pass --pom');
        }
    } else {
        await requireFile(session.sandbox, pom, 'pom');
    }
    LOG.ok(`         POM: ${WORK_DIR}/${pom}`);

    LOG.step('Port');
    let port = opts.port;
    if(port === undefined) {
        port = await freePort();
    }else if(await hostPortListening('127.0.0.1', port)){
        die(`host port ${port} is already in use`);
    }
    LOG.ok(`        Port: ${port}`);

    LOG.step(`Starting the trace viewer`);
    const viewer = await startViewer(session.sandbox, pom, trace, port);

    // From here on there is something to tear down, whichever way this ends.
    const spec: PortSpec = { bind: '127.0.0.1', host: port, guest: port };
    let stopped = false;
    const teardown = async (): Promise<void> => {
        if (stopped) {
            return;
        }
        stopped = true;
        stopForward(instance, port);
        await viewer.handle.kill().catch(() => {
        });
        // Killing the host-side exec does not reap the guest process -- the
        // same lesson vm/dockerd-run.sh records.
        await execInSandbox(session.sandbox, {
            cmd: 'pkill',
            args: ['-f', 'com.microsoft.playwright.CLI'],
            timeoutMs: 20_000,
        }).catch(() => {
        });
    };

    let onSignal = (): void => {
    };
    const interrupted = new Promise<'interrupted'>((resolve) => {
        onSignal = (): void => resolve('interrupted');
    });
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    try {
        await waitForViewer(session.sandbox, viewer, port);
        LOG.ok(`viewer on vm:${port}`);

        LOG.step(`Forwarding vm:${port}`);
        const tunnels = await prepareTunnels(sessionSandboxName(instance));
        if (!(await startForward(instance, tunnels, spec))) {
            die('could not forward the viewer out');
        }

        // The bare origin is the right URL: show-trace answers it with a
        // RELATIVE redirect to the trace, which the browser resolves against
        // whatever origin it asked -- the forwarded one included.
        const url = `http://127.0.0.1:${port}/`;
        LOG.ok(url);
        if (opts.open) {
            await execOnHost({ cmd: 'open', args: [url] }).catch(() => undefined);
        }
        LOG.info('Ctrl-C to stop the viewer and drop the forward');

        const outcome = await Promise.race([viewer.exited, interrupted]);
        if (outcome !== 'interrupted') {
            LOG.warn('the trace viewer exited');
            return 1;
        }
        return 0;
    } finally {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        await teardown();
    }
}

function logMetadata(project: Project, instance: Instance): void {
    LOG.ok(`        Name: ${project.name}`);
    LOG.ok(`        Root: ${project.root}`);
    LOG.ok(`      Config: ${existsSync(project.configFile) ? project.configFile : `no ${CONFIG_FILE} -- using defaults`}`);
    LOG.ok(`    Instance: ${instance.name}`);
}

async function pickTrace(sandbox: Sandbox, session: string, count: number): Promise<string> {
    const traces = await findRecentTraces(sandbox, count);
    if (traces.length === 0) {
        die(`no traces under */${TRACES_DIR}/ in ${session}; pass a path`);
    }

    LOG.ok("Most recent traces")
    traces.forEach((t, i) => LOG.ok(`  ${i + 1}) ${describeTrace(t.rel)}  (${age(t.mtimeMs)})\n`));
    LOG.ok(`Press 1-${traces.length} to open, q to cancel: `);

    const key = await readKey();
    LOG.debug(`${key}`);
    const n = Number(key);
    const chosen = Number.isInteger(n) ? traces[n - 1] : undefined;
    if (chosen === undefined) {
        die('cancelled');
    }

    return chosen.rel;
}

/**
 * One keypress, no Enter. Raw mode swallows Ctrl-C as a plain byte rather than
 * a SIGINT, so it is mapped to cancel here; Esc and q cancel too, and so does
 * any other key that is not a listed number (the caller's range check).
 */
function readKey(): Promise<string> {
    const stdin = process.stdin;
    return new Promise((resolve) => {
        const onData = (data: Buffer): void => {
            const key = data.toString();
            stdin.removeListener('data', onData);
            stdin.setRawMode(false);
            stdin.pause();
            resolve(key === '\x03' || key === '\x1b' ? 'q' : key.charAt(0));
        };
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on('data', onData);
    });
}

async function requireFile(sandbox: Sandbox, rel: string, what: string): Promise<void> {
    const found = await execInSandbox(sandbox, {
        cmd: 'test',
        args: ['-f', `${WORK_DIR}/${rel}`],
        timeoutMs: 30_000,
    });
    if (!found.ok) die(`no such ${what} in the VM: ${WORK_DIR}/${rel}`);
}

/**
 * The pom of the module the trace was written by: the nearest pom.xml above
 * it. Traces land in the test module's own target/, and that module is the one
 * with Playwright on its test classpath.
 */
async function guessPom(sandbox: Sandbox, trace: string): Promise<string | undefined> {
    const found = await execInSandbox(sandbox, {
        cmd: 'bash',
        args: [
            '-c',
            'dir=$(dirname "$SEU_TRACE"); ' +
            'while [ "$dir" != . ]; do ' +
            '[ -f "$dir/pom.xml" ] && { echo "$dir/pom.xml"; exit 0; }; ' +
            'dir=$(dirname "$dir"); ' +
            'done; exit 1',
        ],
        cwd: WORK_DIR,
        env: { SEU_TRACE: trace },
        timeoutMs: 30_000,
    });
    return found.ok ? found.stdout.trim() : undefined;
}

/** The first host port in Playwright's range that nothing is listening on. */
async function freePort(): Promise<number> {
    for (let port = FIRST_PORT; port <= LAST_PORT; port++) {
        if (!(await hostPortListening('127.0.0.1', port))) {
            return port;
        }
    }

    return die(`no free host port between ${FIRST_PORT} and ${LAST_PORT} -- pass --port`);
}
