// `seu pull`. The flow itself lives in src/cmd/pull/run.ts.

import type { Command } from '../command.ts';

export const PULL: Command = {
    name: 'pull',
    args: '[--name <name>]',
    summary: 'fetch the commits you made in ~/work back onto the host',

    details: `Work done in the sandbox comes home as git objects, over a bundle.

\`git bundle create --all\` runs in ~/work and the bundle is copied out through the sandbox's own file channel. That is the whole transport: no network path out of the VM, no SSH key in it, and no writable host mount -- the bundle is a file, and a file is all that crosses.

On the host the bundle is wired up as a git remote and fetched. Nothing is merged: the fetch gives you refs to look at, and the command prints the three commands worth running before you decide. The bundle itself stays in the project's state directory and is replaced on the next pull, so the remote keeps working between pulls and always points at the last one.

The remote is named after the SEU -- \`seu-<name>\`, which by default is the worktree's directory name -- because worktrees of one repository, and SEUs of one worktree, share a ref namespace, and a fixed name would make two of them overwrite each other's fetched refs. SEU_REMOTE overrides it.

This needs at least one commit in ~/work: a bundle of nothing is an error, not an empty bundle.`,

    options: [
        { flag: '--name, -n <name>', text: 'the SEU to pull from; default: the worktree\'s directory name' },
    ],

    async run(argv: string[]): Promise<void> {
        // Imported here rather than at the top: the flow is what pulls in the
        // microsandbox SDK, and `seu help` must not need it.
        const { run } = await import('./run.ts');
        await run(argv);
    },
};
