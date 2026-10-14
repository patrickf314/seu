import { execOnHost } from './exec.ts';

/**
 * Opens a URL in the host's default browser: `open` on macOS, `xdg-open`
 * elsewhere. Best effort -- the caller has already printed the URL.
 */
export async function openOnHost(url: string): Promise<void> {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    await execOnHost({ cmd, args: [url] }).catch(() => undefined);
}
