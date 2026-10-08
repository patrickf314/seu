// Which microsandbox runtime the SDK drives.
//
// The SDK refuses to launch a sandbox with a runtime it did not ship:
//
//   RuntimeError: runtime error: no tested sandbox launch contract for runtime 0.7.6
//
// -- and that is raised for the copy in ~/.microsandbox/bin even when its
// version matches the package exactly. So the binary and its firmware come
// from the platform package npm installed next to the SDK.
//
// MSB_HOME is deliberately NOT touched: the home stays ~/.microsandbox, so the
// sandboxes, named volumes and image cache seen here are the same ones the
// `msb` CLI and the bash half of seu see. Only the executable differs.
//
// Both variables are honoured if the caller already set them, which is the
// escape hatch for running against a hand-built runtime.

import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LOG } from "./common/log.ts";
import { sdk } from "./msb/sdk.ts";
import { die } from "./common/error.ts";

const PLATFORM_PACKAGES: Record<string, string> = {
  "darwin-arm64": "@superradcompany/microsandbox-darwin-arm64",
  "linux-x64": "@superradcompany/microsandbox-linux-x64-gnu",
  "linux-arm64": "@superradcompany/microsandbox-linux-arm64-gnu",
  "win32-x64": "@superradcompany/microsandbox-win32-x64-msvc",
  "win32-arm64": "@superradcompany/microsandbox-win32-arm64-msvc",
};

/**
 * Point the SDK at its own runtime. Must run before the first sandbox call;
 * the paths are read when a sandbox is created, not when the SDK is imported.
 */
export function useSdkRuntime(): void {
  if (process.env["MSB_PATH"] && process.env["MSB_LIBKRUNFW_PATH"]) return;

  const key = `${process.platform}-${process.arch}`;
  const pkg = PLATFORM_PACKAGES[key];
  if (!pkg) die(`no microsandbox platform package for ${key}`);

  let root: string;
  try {
    root = dirname(createRequire(import.meta.url).resolve(`${pkg}/package.json`));
  } catch {
    return die(
      `the microsandbox SDK is not installed for this platform (${pkg}).\n` +
        `    npm install microsandbox, with optional dependencies enabled`,
    );
  }

  const msb = join(root, "bin", process.platform === "win32" ? "msb.exe" : "msb");
  // The firmware is versioned in its file name (libkrunfw.5.dylib today), so
  // it is discovered rather than spelled out.
  const libDir = join(root, "lib");
  const firmware = existsSync(libDir)
    ? readdirSync(libDir).find((f) => f.startsWith("libkrunfw") && !f.endsWith(".dylib.dSYM"))
    : undefined;
  if (!existsSync(msb) || !firmware) die(`${pkg} is incomplete: no msb binary or libkrunfw in ${root}`);

  process.env["MSB_PATH"] ??= msb;
  process.env["MSB_LIBKRUNFW_PATH"] ??= join(libDir, firmware);
}

/**
 * The bash half of seu still drives the `msb` CLI in MSB_HOME, and the two
 * share one database. An SDK newer than that CLI migrates the schema past what
 * it can read, and every bash command then fails with "database schema is
 * newer than this msb binary". Cheap to detect, miserable to diagnose.
 */
export async function warnOnRuntimeSkew(): Promise<void> {
  const home = process.env["MSB_HOME"] ?? join(homedir(), ".microsandbox");
  const cli = join(home, "bin", process.platform === "win32" ? "msb.exe" : "msb");
  const sdkMsb = process.env["MSB_PATH"];
  if (!sdkMsb || !existsSync(cli)) return;

  // Reads the version section out of the executable; it is never run.
  const { resolveRuntimeVersion } = await sdk();
  const [cliVersion, sdkVersion] = await Promise.all([
    resolveRuntimeVersion(cli).catch(() => null),
    resolveRuntimeVersion(sdkMsb).catch(() => null),
  ]);
  if (cliVersion && sdkVersion && cliVersion !== sdkVersion) {
    LOG.warn(`msb CLI in ${home} is ${cliVersion}, the SDK runtime is ${sdkVersion}`);
    LOG.warn(`    they share one database -- install the SDK's binary to keep the bash commands working:`);
    LOG.warn(`    cp ${sdkMsb} ${cli}`);
  }
}
