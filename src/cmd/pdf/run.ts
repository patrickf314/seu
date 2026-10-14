// The `seu pdf` flow: a PDF in the session, served there and reached from the
// host over an ordinary `seu port` forward. The same shape as `seu playwright`
// (src/cmd/playwright/run.ts), with a one-file web server in place of the
// trace viewer.

import { existsSync } from 'node:fs';
import { LOG } from '../../common/log.ts';
import { die } from '../../common/error.ts';
import { type InstanceOptions, parseArgs } from '../../common/args.ts';
import { guestPath } from '../../common/guest-path.ts';
import { WORK_DIR } from '../../common/constants.ts';
import { openOnHost } from '../../host/open.ts';
import { type Instance, type Project, resolveInstance, resolveProject } from '../../config/project.ts';
import { CONFIG_FILE } from '../../config/config.ts';
import { resumeSession, sessionSandboxName } from '../../msb/session.ts';
import { execInSandbox } from '../../msb/exec.ts';
import {
    hostPortListening,
    parsePort,
    type PortSpec,
    prepareTunnels,
    startForward,
    stopForward,
} from '../../network/forward.ts';
import { waitForViewer } from '../../playwright/viewer.ts';
import { age } from '../../playwright/traces.ts';
import { findNewestPdf, SERVED_NAME, startPdfServer } from '../../pdf/serve.ts';

const FIRST_PORT = 9400;
const LAST_PORT = 9410;

interface PdfOptions {
    pdf: string | undefined;
    port: number | undefined;
    open: boolean;
}

export async function run(argv: string[]): Promise<number> {
    return pdf(
        parseArgs<PdfOptions>(argv, {
            command: 'pdf',
            defaults: { pdf: undefined, port: undefined, open: true },
            flags: {
                '--port': (opts, value) => (opts.port = parsePort(value())),
                '--no-open': { open: false },
            },
            positional: (opts, arg) => {
                if (opts.pdf !== undefined) die(`one PDF at a time, got ${opts.pdf} and ${arg}`);
                opts.pdf = guestPath(arg, 'pdf');
            },
        }),
    );
}

async function pdf(opts: PdfOptions & InstanceOptions): Promise<number> {
    LOG.step('Metadata');
    const project = await resolveProject();
    const instance = resolveInstance(project, opts.name);
    const session = await resumeSession(instance);
    logMetadata(project, instance);

    LOG.step(`PDF in ${session.name}`);
    let file = opts.pdf;
    if (file === undefined) {
        const newest = await findNewestPdf(session.sandbox);
        if (newest === undefined) {
            die(`no PDF under ${WORK_DIR} in ${session.name}; pass a path`);
        }
        file = newest.rel;
        LOG.ok(`        File: ${file}  (${age(newest.mtimeMs)})`);
    } else {
        const found = await execInSandbox(session.sandbox, {
            cmd: 'test',
            args: ['-f', `${WORK_DIR}/${file}`],
            timeoutMs: 30_000,
        });
        if (!found.ok) die(`no such PDF in the VM: ${WORK_DIR}/${file}`);
        LOG.ok(`        File: ${file}`);
    }

    LOG.step('Port');
    let port = opts.port;
    if (port === undefined) {
        port = await freePort();
    } else if (await hostPortListening('127.0.0.1', port)) {
        die(`host port ${port} is already in use`);
    }
    LOG.ok(`        Port: ${port}`);

    LOG.step('Serving the PDF');
    const server = await startPdfServer(session.sandbox, file, port);

    // From here on there is something to tear down, whichever way this ends.
    const spec: PortSpec = { bind: '127.0.0.1', host: port, guest: port };
    let stopped = false;
    const teardown = async (): Promise<void> => {
        if (stopped) {
            return;
        }
        stopped = true;
        stopForward(instance, port);
        await server.handle.kill().catch(() => undefined);
        // Killing the host-side exec does not reap the guest process -- the
        // same lesson vm/dockerd-run.sh records.
        await execInSandbox(session.sandbox, {
            cmd: 'pkill',
            args: ['-f', `http.server ${port} `],
            timeoutMs: 20_000,
        }).catch(() => undefined);
    };

    let onSignal = (): void => {};
    const interrupted = new Promise<'interrupted'>((resolve) => {
        onSignal = (): void => resolve('interrupted');
    });
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    try {
        await waitForViewer(session.sandbox, server, port, 'the PDF server');
        LOG.ok(`server on vm:${port}`);

        LOG.step(`Forwarding vm:${port}`);
        const tunnels = await prepareTunnels(sessionSandboxName(instance));
        if (!(await startForward(instance, tunnels, spec))) {
            die('could not forward the PDF out');
        }

        const url = `http://127.0.0.1:${port}/${SERVED_NAME}`;
        LOG.ok(url);
        if (opts.open) {
            await openOnHost(url);
        }
        LOG.info('Ctrl-C to stop serving and drop the forward');

        const outcome = await Promise.race([server.exited, interrupted]);
        if (outcome !== 'interrupted') {
            LOG.warn('the PDF server exited');
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

/** The first host port in the PDF range that nothing is listening on. */
async function freePort(): Promise<number> {
    for (let port = FIRST_PORT; port <= LAST_PORT; port++) {
        if (!(await hostPortListening('127.0.0.1', port))) {
            return port;
        }
    }

    return die(`no free host port between ${FIRST_PORT} and ${LAST_PORT} -- pass --port`);
}
