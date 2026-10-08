// `seu remove`. The flow itself lives in src/cmd/remove/run.ts.

import type { Command } from '../command.ts';

export const REMOVE: Command = {
    name: 'remove',
    aliases: ['rm'],
    args: '[options]',
    summary: 'delete a SEU: its sandboxes, its volume and its state',

    details: `Deletes the SEU named by --name -- by default the worktree's own -- for good: the session sandbox, an install sandbox a killed \`seu start\` may have left behind, its port forwards, and its named volume. The volume is ~/work, ~/.m2, ~/.cache and every pulled Docker image; the next \`seu start\` of that name begins from nothing.

Before anything is deleted, a running session is checked for work that exists nowhere else: uncommitted changes in ~/work, and branches whose commits the host repository does not have -- i.e. that were never \`seu pull\`ed. If there is any, the command refuses until you pull it or pass --force. A stopped session cannot be checked without starting it, which it says.

It then asks you to type the SEU's name; --yes skips that, for scripts.

What \`seu pull\` brought over is kept: the bundle stays in the state directory and the git remote \`seu-<name>\` keeps working, because commits you fetched but did not merge yet may exist only there. Drop it with \`git remote remove seu-<name>\` once merged.`,

    options: [
        { flag: '--name, -n <name>', text: 'the SEU to remove; default: the worktree\'s directory name' },
        { flag: '--keep-volume', text: 'remove only the sandboxes; the next `seu start` creates a session over the kept volume' },
        { flag: '--yes, -y', text: 'do not ask for confirmation' },
        { flag: '--force', text: 'remove even when ~/work has changes or commits the host does not have' },
    ],

    async run(argv: string[]): Promise<void> {
        // Imported here rather than at the top: the flow is what pulls in the
        // microsandbox SDK, and `seu help` must not need it.
        const { run } = await import('./run.ts');
        await run(argv);
    },
};
