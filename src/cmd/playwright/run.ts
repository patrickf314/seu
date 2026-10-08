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

import type { ExecHandle, Sandbox } from 'microsandbox';
import { LOG } from '../../common/log.ts';
import { die } from '../../common/error.ts';
import { sleep } from '../../common/utils.ts';
import { type InstanceOptions, parseArgs } from '../../common/args.ts';
import { execOnHost } from '../../host/exec.ts';
import { resolveInstance, resolveProject } from '../../config/project.ts';
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

/** Playwright's own default for show-trace, and ten more after it. */
const FIRST_PORT = 9323;
const LAST_PORT = 9333;

/**
 * A cold `mvn exec:java` is slow, and the driver unpacks its node bundle on
 * first use, so this budget is generous on purpose.
 */
const READY_TIMEOUT_MS = 2 * 60_000;

interface TraceOptions {
    trace: string | undefined;
    port: number | undefined;
    pom: string | undefined;
    open: boolean;
}

export async function run(argv: string[]): Promise<number> {
    return trace(
        parseArgs<TraceOptions>(argv, {
            command: 'playwright',
            defaults: { trace: undefined, port: undefined, pom: undefined, open: true },
            flags: {
                '--port': (opts, value) => (opts.port = parsePort(value())),
                '--pom': (opts, value) => (opts.pom = guestPath(value(), 'pom')),
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
    if (rel.startsWith('/')) die(`the ${what} path must be relative to ${WORK_DIR}: ${raw}`);
    if (rel.split('/').includes('..')) die(`the ${what} path must not contain '..': ${raw}`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(rel)) die(`not a usable ${what} path: ${raw}`);
    return rel;
}

async function trace(opts: TraceOptions & InstanceOptions): Promise<number> {
    if (opts.trace === undefined) die('which trace? e.g. `seu playwright club/ui/target/trace.zip`');

    const project = await resolveProject();
    const instance = resolveInstance(project, opts.name);
    const configured = opts.pom;

    const session = await resumeSession(instance);
    await requireFile(session.sandbox, opts.trace, 'trace');

    let pom: string;
    if (configured !== undefined) {
        pom = configured;
        await requireFile(session.sandbox, pom, 'pom');
    } else {
        pom =
            (await guessPom(session.sandbox, opts.trace)) ??
            die('which module has Playwright on its classpath? pass --pom');
        LOG.info(`using ${WORK_DIR}/${pom}; pass --pom if that is the wrong module`);
    }

    const port = opts.port ?? (await freePort());
    if (opts.port !== undefined && (await hostPortListening('127.0.0.1', port))) {
        die(`host port ${port} is already in use`);
    }

    LOG.step(`Starting the trace viewer in ${session.name}`);
    LOG.info(`${WORK_DIR}/${opts.trace}`);
    const viewer = await startViewer(session.sandbox, pom, opts.trace, port);

    // From here on there is something to tear down, whichever way this ends.
    const spec: PortSpec = { bind: '127.0.0.1', host: port, guest: port };
    let stopped = false;
    const teardown = async (): Promise<void> => {
        if (stopped) return;
        stopped = true;
        stopForward(instance, port);
        await viewer.handle.kill().catch(() => {});
        // Killing the host-side exec does not reap the guest process -- the
        // same lesson vm/dockerd-run.sh records.
        await execInSandbox(session.sandbox, {
            cmd: 'pkill',
            args: ['-f', 'com.microsoft.playwright.CLI'],
            timeoutMs: 20_000,
        }).catch(() => {});
    };

    let onSignal = (): void => {};
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
        if (!(await startForward(instance, tunnels, spec))) die('could not forward the viewer out');

        // The bare origin is the right URL: show-trace answers it with a
        // RELATIVE redirect to the trace, which the browser resolves against
        // whatever origin it asked -- the forwarded one included.
        const url = `http://127.0.0.1:${port}/`;
        LOG.ok(url);
        if (opts.open) await execOnHost({ cmd: 'open', args: [url] }).catch(() => undefined);
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
        if (!(await hostPortListening('127.0.0.1', port))) return port;
    }
    return die(`no free host port between ${FIRST_PORT} and ${LAST_PORT} -- pass --port`);
}

interface Viewer {
    readonly handle: ExecHandle;
    /** Resolves once the viewer process is gone, for whatever reason. */
    readonly exited: Promise<'exited'>;
    /** What it printed, kept for when it dies before opening its port. */
    readonly output: string[];
}

/**
 * `-o` because the session has no network to Maven Central. `--host/--port` is
 * what makes show-trace SERVE the viewer rather than launch Playwright's bundled
 * browser app; it still tries to open a tab in the guest, where there is no
 * browser to show it, but Playwright swallows that failure and keeps serving.
 *
 * Every value reaches the command through the environment, so the paths -- as
 * validated as they are -- never become shell syntax.
 */
async function startViewer(sandbox: Sandbox, pom: string, trace: string, port: number): Promise<Viewer> {
    const handle = await sandbox.execStreamWith('bash', (b) =>
        b
            .args([
                '-lc',
                'exec mvn -B -o exec:java --file "$SEU_POM" ' +
                    '-Dexec.mainClass=com.microsoft.playwright.CLI ' +
                    '-Dexec.args="show-trace --host 127.0.0.1 --port $SEU_PORT $SEU_TRACE"',
            ])
            .user('seu')
            .cwd(WORK_DIR)
            .envs({ SEU_POM: pom, SEU_PORT: String(port), SEU_TRACE: `${WORK_DIR}/${trace}` }),
    );

    const output: string[] = [];
    const exited = (async (): Promise<'exited'> => {
        try {
            for await (const event of handle) {
                if (event.kind === 'stdout' || event.kind === 'stderr') {
                    output.push(...Buffer.from(event.data).toString().split('\n').filter((l) => l !== ''));
                    output.splice(0, Math.max(0, output.length - 200));
                }
            }
        } catch {
            /* the handle was killed at teardown */
        }
        return 'exited';
    })();

    return { handle, exited, output };
}

/** Until something listens on the guest port, the viewer dies, or time runs out. */
async function waitForViewer(sandbox: Sandbox, viewer: Viewer, port: number): Promise<void> {
    let gone = false;
    void viewer.exited.then(() => (gone = true));

    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (gone) {
            report(viewer);
            die('the trace viewer exited before it opened a port');
        }

        const probe = await execInSandbox(sandbox, {
            cmd: 'bash',
            args: ['-c', `exec 3<>/dev/tcp/127.0.0.1/${port}`],
            timeoutMs: 10_000,
        });
        if (probe.ok) return;
        await sleep(2000);
    }

    report(viewer);
    die(`the trace viewer never opened vm:${port}`);
}

function report(viewer: Viewer): void {
    for (const line of viewer.output.slice(-15)) LOG.debug(`    ${line}`);
}
