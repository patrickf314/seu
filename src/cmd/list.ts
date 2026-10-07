// `seu list`. The flow itself lives in src/cmd/list/run.ts.

import type { Command } from './command.ts';

export const LIST: Command = {
    name: 'list',
    args: '[--here]',
    summary: 'list every SEU on this machine, with its worktree and port forwards',

    details: `One line per SEU: its name, whether its session sandbox is running, the base image it was created from, its active port forwards and the worktree it sandboxes. A \`*\` marks the SEUs of the worktree you are in.

An install sandbox that is still around is listed too, as \`installing\`: either a \`seu start\` is running right now, or one was killed hard enough that its teardown never ran. In the second case the next \`seu start\` of that SEU replaces it.

The list goes to stdout, everything else to stderr, so it can be piped.`,

    options: [
        { flag: '--here', text: 'only the SEUs of the current worktree' },
    ],

    async run(argv: string[]): Promise<void> {
        // Imported here rather than at the top: the flow is what pulls in the
        // microsandbox SDK, and `seu help` must not need it.
        const { run } = await import('./list/run.ts');
        await run(argv);
    },
};
