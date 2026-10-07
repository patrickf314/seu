// Host-side port forwarding: SSH tunnels from the Mac into a running sandbox.
// Port of the host-SSH and port-forwarding halves of lib/common.sh.
//
// Why SSH and not a published port? `msb create` does take -p HOST:GUEST, but
// ports are fixed at CREATE time -- there is no flag to add one to a sandbox
// that exists. Using it would mean re-creating the session every time you want
// to look at a dev server: root disk gone, dockerd and session-init re-run,
// every running process killed.
//
// microsandbox's own SSH server implements the direct-tcpip channel and relays
// it into the guest, so a plain openssh `ssh -N -L` forwards into a RUNNING
// sandbox with nothing restarted, and a forward can be added or dropped at any
// time. `msb ssh serve --stdio` serves one SSH transport over stdin/stdout,
// which is exactly what ProxyCommand wants -- and it is the one place seu still
// drives the msb executable rather than the SDK, because the SDK exposes no
// port-forwarding API of its own.
//
// A tunnel does NOT survive the sandbox stopping: there is nothing on the other
// end of it any more. `seu stop` is expected to tear them down, and a forward
// whose ssh has died is pruned by the listing below.

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOG } from '../common/log.ts';
import { die } from '../common/error.ts';
import { run, sleep } from '../host.ts';
import { sdk } from '../microsandbox/microsandboxSdk.ts';
import { STATE_ROOT, type Instance } from '../config/project.ts';

/**
 * Forwards are recorded per SEU, in its state dir, and that is all they need
 * to know about it -- which is what lets `seu list` read them for a SEU it only
 * knows by sandbox name.
 */
type ForwardOwner = Pick<Instance, 'stateDir'>;

/** What the user asked for, once it has been validated. */
export interface PortSpec {
    /** Host interface to bind. 127.0.0.1 unless asked otherwise. */
    readonly bind: string;
    readonly host: number;
    readonly guest: number;
}

/** A forward that is currently up, as recorded on disk. */
export interface ActiveForward extends PortSpec {
    readonly pid: number;
}

/**
 * How long ssh gets to bind the host port before the forward is called a
 * failure. ExitOnForwardFailure makes a busy port a fast, clean exit, so this
 * only ever expires on something genuinely stuck.
 */
const READY_TIMEOUT_SECS = 15;

// --------------------------------------------------------------- parsing

/**
 * A spec is docker's: GUEST, HOST:GUEST or BIND:HOST:GUEST.
 *
 * Validated hard, because it ends up in an `ssh -L` argument and a seu
 * invariant is that nothing from outside is trusted. The default bind is
 * 127.0.0.1 rather than 0.0.0.0: a forward into a sandbox should not quietly
 * publish that sandbox to the local network. Ask for `*:` to do that.
 */
export function parsePortSpec(raw: string): PortSpec {
    let spec = raw;

    const protocol = /\/(tcp|udp)$/i.exec(spec);
    if (protocol !== null) {
        if (protocol[1].toLowerCase() === 'udp') {
            die(`ssh -L forwards TCP only, so ${raw} is not supported`);
        }
        spec = spec.slice(0, protocol.index);
    }

    const [rawBind, rawHost, rawGuest] = split(spec, raw);

    const bind = rawBind === '*' ? '0.0.0.0' : rawBind === 'localhost' ? '127.0.0.1' : rawBind;
    if (!isIPv4(bind)) {
        die(`not a usable bind address: ${rawBind} (use an IPv4 literal, localhost or *)`);
    }

    return { bind, host: parsePort(rawHost), guest: parsePort(rawGuest) };
}

function split(spec: string, raw: string): [string, string, string] {
    const parts = spec.split(':');
    switch (parts.length) {
        case 1:
            return ['127.0.0.1', parts[0], parts[0]];
        case 2:
            return ['127.0.0.1', parts[0], parts[1]];
        case 3:
            return [parts[0], parts[1], parts[2]];
        default:
            return die(`not a usable port spec: ${raw} (expected PORT, HOST:GUEST or BIND:HOST:GUEST)`);
    }
}

const isIPv4 = (value: string): boolean =>
    /^\d{1,3}(\.\d{1,3}){3}$/.test(value) && value.split('.').every((o) => Number(o) <= 255);

export function parsePort(value: string): number {
    if (!/^\d{1,5}$/.test(value)) die(`not a usable port: ${value} (1-65535)`);
    const port = Number(value);
    if (port < 1 || port > 65535) die(`not a usable port: ${value} (1-65535)`);
    return port;
}

// ------------------------------------------------------------- the records
// One file per forward, keyed by HOST port -- that is what is unique on the
// Mac, and what you name to drop one again.
//
//   <state>/ports/<hostport>.fwd   "<bind> <hostport> <guestport> <pid>"
//   <state>/ports/<hostport>.log   that tunnel's ssh stderr

const forwardDir = (instance: ForwardOwner): string => join(instance.stateDir, 'ports');

const recordFile = (instance: ForwardOwner, host: number): string => join(forwardDir(instance), `${host}.fwd`);

const logFile = (instance: ForwardOwner, host: number): string => join(forwardDir(instance), `${host}.log`);

function readRecord(instance: ForwardOwner, host: number): ActiveForward | undefined {
    const file = recordFile(instance, host);
    if (!existsSync(file)) return undefined;

    const [bind, , guest, pid] = readFileSync(file, 'utf8').trim().split(/\s+/);
    const forward = { bind, host, guest: Number(guest), pid: Number(pid) };
    return Number.isInteger(forward.guest) && Number.isInteger(forward.pid) ? forward : undefined;
}

/** True when that pid is still there. The record is a claim; this checks it. */
function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Every forward that is actually up, pruning the records whose ssh has died --
 * which is every one of them after a `seu stop`.
 */
export function listForwards(instance: ForwardOwner): ActiveForward[] {
    const dir = forwardDir(instance);
    if (!existsSync(dir)) return [];

    const forwards: ActiveForward[] = [];
    for (const entry of readdirSync(dir).sort()) {
        if (!entry.endsWith('.fwd')) continue;

        const host = Number(entry.slice(0, -'.fwd'.length));
        const forward = Number.isInteger(host) ? readRecord(instance, host) : undefined;
        if (forward !== undefined && alive(forward.pid)) {
            forwards.push(forward);
        } else {
            rmSync(join(dir, entry), { force: true });
        }
    }
    return forwards;
}

export function forwardUp(instance: ForwardOwner, host: number): boolean {
    const forward = readRecord(instance, host);
    return forward !== undefined && alive(forward.pid);
}

/**
 * Drop one forward. The log goes with the record: a tunnel that came up
 * cleanly leaves an empty one, and a tunnel that failed never got a record, so
 * its log survives to be read.
 */
export function stopForward(instance: ForwardOwner, host: number): void {
    const forward = readRecord(instance, host);
    if (forward !== undefined) {
        try {
            process.kill(forward.pid);
        } catch {
            /* already gone, which is the state we wanted */
        }
    }
    rmSync(recordFile(instance, host), { force: true });
    rmSync(logFile(instance, host), { force: true });
}

export function stopAllForwards(instance: ForwardOwner): void {
    const dir = forwardDir(instance);
    if (!existsSync(dir)) return;

    for (const entry of readdirSync(dir)) {
        if (entry.endsWith('.fwd')) stopForward(instance, Number(entry.slice(0, -'.fwd'.length)));
    }
}

// ----------------------------------------------------------------- host SSH
// The key is seu's own, under the state directory -- never ~/.ssh. `msb ssh
// serve` refuses to run without an authorized key ("SSH server has no
// authorized public keys"), and `msb ssh authorize` is idempotent.

/**
 * Everything a tunnel needs that is worth working out once: the key is
 * generated and authorized, and the msb executable resolved, before the first
 * `ssh` is spawned rather than once per forward.
 */
export interface Tunnels {
    readonly sandbox: string;
    readonly sshArgs: readonly string[];
}

export async function prepareTunnels(sandbox: string): Promise<Tunnels> {
    const key = await sshKey();
    const msb = await msbPath();

    const authorize = await run(msb, ['ssh', 'authorize', '--file', `${key}.pub`]);
    if (authorize.code !== 0) die(`msb ssh authorize failed for ${key}.pub`);

    return { sandbox, sshArgs: sshArgs(sandbox, key, msb) };
}

async function sshKey(): Promise<string> {
    const dir = join(STATE_ROOT, 'ssh');
    const key = join(dir, 'id_ed25519');
    if (existsSync(key)) return key;

    mkdirSync(dir, { recursive: true });
    const generated = await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'seu', '-f', key, '-q']).catch(
        (err: Error) => die(`seu port needs OpenSSH: ${err.message}`),
    );
    if (generated.code !== 0) die(`could not generate the seu SSH key at ${key}`);
    return key;
}

/**
 * The msb executable the SDK itself would drive, so a tunnel talks to the same
 * runtime -- and the same sandbox database -- as everything else seu does.
 */
async function msbPath(): Promise<string> {
    const { resolveRuntime } = await sdk();
    try {
        return resolveRuntime().msbPath;
    } catch (err) {
        return die(`no usable microsandbox runtime: ${(err as Error).message}`);
    }
}

/** -F /dev/null, so a personal ~/.ssh/config cannot redirect any of this. */
function sshArgs(sandbox: string, key: string, msb: string): string[] {
    return [
        '-F', '/dev/null',
        '-i', key,
        '-o', 'IdentitiesOnly=yes',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'LogLevel=ERROR',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=30',
        '-o', `ProxyCommand=${quote(msb)} ssh serve --stdio --no-inactivity-timeout ${quote(sandbox)}`,
    ];
}

/** ProxyCommand is handed to /bin/sh, and the SDK's msb lives under node_modules. */
const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

// ------------------------------------------------------------- the tunnels

/**
 * Bring one forward up. Returns false for a forward that did not come up,
 * having said why -- the caller decides whether that fails the command.
 */
export async function startForward(instance: ForwardOwner, tunnels: Tunnels, spec: PortSpec): Promise<boolean> {
    const { bind, host, guest } = spec;
    const label = `${bind}:${host} -> vm:${guest}`;

    if (forwardUp(instance, host)) {
        LOG.info(`${label} already forwarded`);
        return true;
    }
    rmSync(recordFile(instance, host), { force: true });

    // Before starting ssh, not after: once it is running, "something is
    // listening on $host" is ambiguous -- it could be the squatter rather than
    // our tunnel, which is exactly how a failed bind used to report success.
    if (await hostPortListening(bind, host)) {
        LOG.warn(`host port ${host} is already in use -- not forwarding to vm:${guest}`);
        const holder = await portHolder(host);
        if (holder !== undefined) LOG.info(holder);
        return false;
    }

    const pid = spawnTunnel(instance, tunnels, spec);
    if (pid === undefined) return false;

    writeFileSync(recordFile(instance, host), `${bind} ${host} ${guest} ${pid}\n`);

    for (let i = 0; i < READY_TIMEOUT_SECS; i++) {
        if (!alive(pid)) {
            rmSync(recordFile(instance, host), { force: true });
            return failed(instance, `could not forward ${label}`, host);
        }

        if (await hostPortListening(bind, host)) {
            // The port was free a moment ago, so a listener now is ours. Give
            // ssh a beat to fall over anyway, then confirm it is still there.
            await sleep(1000);
            if (alive(pid)) {
                LOG.ok(label);
                return true;
            }
            continue;
        }
        await sleep(1000);
    }

    return failed(instance, `${label}: ssh is running but the port never opened`, host);
}

/**
 * The guest-side destination is `localhost`, NOT the 127.0.0.1 literal. A Vite
 * dev server binds [::1] only, so an IPv4 literal finds nothing there and the
 * forward comes up but refuses every connection. `localhost` lets the guest
 * resolver try both families, which also reaches 127.0.0.1-only listeners (the
 * trace viewer) and 0.0.0.0 ones (docker-proxy).
 */
function spawnTunnel(instance: ForwardOwner, tunnels: Tunnels, spec: PortSpec): number | undefined {
    const log = logFile(instance, spec.host);
    mkdirSync(forwardDir(instance), { recursive: true });
    writeFileSync(log, '');

    const fd = openSync(log, 'a');
    try {
        // Detached and unref'd: the tunnel is the point, and it has to outlive
        // the `seu port` that asked for it.
        const child = spawn(
            'ssh',
            [...tunnels.sshArgs, '-N', '-L', `${spec.bind}:${spec.host}:localhost:${spec.guest}`, `seu@${tunnels.sandbox}`],
            { detached: true, stdio: ['ignore', fd, fd] },
        );
        // Without a listener an ENOENT here is an unhandled 'error' event; the
        // readiness loop reports it as the dead pid it is.
        child.on('error', () => {});
        child.unref();
        return child.pid;
    } finally {
        closeSync(fd);
    }
}

function failed(instance: ForwardOwner, message: string, host: number): boolean {
    LOG.warn(message);
    const log = logFile(instance, host);
    if (existsSync(log)) {
        for (const line of readFileSync(log, 'utf8').trim().split('\n')) {
            if (line !== '') LOG.info(line);
        }
    }
    return false;
}

/**
 * A real connection attempt rather than a parse of `netstat`: it is the only
 * answer that means what the guard above needs it to mean.
 */
export function hostPortListening(bind: string, port: number): Promise<boolean> {
    const host = bind === '0.0.0.0' ? '127.0.0.1' : bind;
    return new Promise((resolve) => {
        const socket = createConnection({ host, port });
        const settle = (listening: boolean): void => {
            socket.destroy();
            resolve(listening);
        };
        socket.setTimeout(1000);
        socket.once('connect', () => settle(true));
        socket.once('timeout', () => settle(false));
        socket.once('error', () => settle(false));
    });
}

/** Who is sitting on the port, when lsof can say. Diagnosis, never a check. */
async function portHolder(port: number): Promise<string | undefined> {
    const listing = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']).catch(() => undefined);
    const line = listing?.stdout.split('\n')[1]?.trim().split(/\s+/);
    return line !== undefined && line.length > 1 ? `held by ${line[0]} (pid ${line[1]})` : undefined;
}
