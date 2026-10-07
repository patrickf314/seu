// `seu help`. The flow itself lives in src/cmd/help/run.ts.

import type { Command } from '../command.ts';

export const HELP: Command = {
    name: 'help',
    args: '[command]',
    summary: 'show this or a command\'s help text',

    async run(argv: string[]): Promise<void> {
        // Imported here rather than at the top: the renderer reads the command
        // set, which in turn lists this const.
        const { run } = await import('./run.ts');
        await run(argv);
    },
};

/**
 * The general help text as a refusal: stderr, and the caller picks the exit code.
 */
export async function usage(message?: string): Promise<void> {
    const { usage } = await import('./run.ts');
    usage(message);
}
