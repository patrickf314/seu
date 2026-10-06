// The microsandbox SDK, loaded on first use.
//
// It is a native addon with a per-platform runtime of its own, so it is the
// one dependency the bundle cannot inline and the one thing an install can
// plausibly be missing. Everything that needs it goes through here, which
// buys two things:
//
//   * `seu help` -- and any command that never touches a sandbox -- works on
//     a checkout with no node_modules at all.
//   * a missing install is one clear sentence instead of a module-resolution
//     stack trace.
//
// Types are imported normally wherever they are needed: `import type` is
// erased, so it costs nothing at runtime.

export type MicrosandboxSdk = typeof import('microsandbox');

let loaded: MicrosandboxSdk | undefined;

export async function sdk(): Promise<MicrosandboxSdk> {
    if (loaded === undefined) {
        loaded = await import('microsandbox');
    }

    return loaded;
}
