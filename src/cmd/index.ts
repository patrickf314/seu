// The command set. One entry per command; `cli.ts` dispatches from here and
// `help.ts` documents from here, so neither can drift from the other.

import { HELP } from './help.ts';
import { LIST } from './list.ts';
import { PLAYWRIGHT } from './playwright.ts';
import { PORT } from './port.ts';
import { PULL } from './pull.ts';
import { REMOVE } from './remove.ts';
import { SHELL } from './shell.ts';
import { START } from './start.ts';
import { STOP } from './stop.ts';
import type { Command } from './command.ts';

/**
 * Listed in the order `seu help` prints them: the lifecycle, then the rest.
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
