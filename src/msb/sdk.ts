/**
 * Type of the microsandbox SDK
 */
export type SDK = typeof import('microsandbox');

let loaded: SDK | undefined;

/**
 * Loads the microsandbox SDK
 */
export async function sdk(): Promise<SDK> {
    if (loaded === undefined) {
        loaded = await import('microsandbox');
    }

    return loaded;
}
