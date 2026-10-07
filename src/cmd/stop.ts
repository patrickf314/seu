// `seu stop`. The flow itself lives in src/cmd/stop/run.ts.

import type { Command } from './command.ts';

export const STOP: Command = {
    name: 'stop',
    args: '[name]',
    summary: 'stop a SEU\'s session sandbox; everything in its volume is kept',

    details: `Stops the session sandbox of the SEU called <name> -- by default the worktree's own -- and drops its port forwards, which have nothing on the other end once it is down.

Nothing is lost: /work, ~/.m2, ~/.cache and the pulled Docker images live in the named volume, and the sandbox keeps its root disk. \`seu start\` or \`seu shell\` brings it back as it was, without installing anything again. Processes running inside -- dockerd, a dev server, a \`claude\` session -- do end, and an attached \`seu shell\` is closed.

To get rid of a SEU for good, use \`seu remove\`.`,

    async run(argv: string[]): Promise<void> {
        // Imported here rather than at the top: the flow is what pulls in the
        // microsandbox SDK, and `seu help` must not need it.
        const { run } = await import('./stop/run.ts');
        await run(argv);
    },
};
