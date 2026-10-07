// The command set. One entry per command; `cli.ts` dispatches from here and
// `help/run.ts` documents from here, so neither can drift from the other.

import { HELP } from './help/index.ts';
import { LIST } from './list/index.ts';
import { PLAYWRIGHT } from './playwright/index.ts';
import { PORT } from './port/index.ts';
import { PULL } from './pull/index.ts';
import { REMOVE } from './remove/index.ts';
import { SHELL } from './shell/index.ts';
import { START } from './start/index.ts';
import { STOP } from './stop/index.ts';
import type { Command } from './command.ts';

/**
 * List of all commands.
 * `seu help` prints them in the specified order
 */
export const COMMANDS: readonly Command[] = [
    START,
    STOP,
    REMOVE,
    LIST,
    SHELL,
    PULL,
    PORT,
    PLAYWRIGHT,
    HELP,
];

/**
 * Finds a command by its name or alias
 *
 * @param name the name to search for
 */
export function findCommand(name: string): Command | undefined {
    return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name) === true);
}
