// The command set. One entry per command; `cli.ts` dispatches from here and
// `help.ts` documents from here, so neither can drift from the other.

import { BUILD } from './build.ts';
import { HELP } from './help.ts';
import type { Command } from './command.ts';

/**
 * Listed in the order `seu help` prints them: the lifecycle, then the rest.
 */
export const COMMANDS: readonly Command[] = [
    BUILD,
    HELP,
];

export function findCommand(name: string): Command | undefined {
    return COMMANDS.find((c) => c.name === name);
}
