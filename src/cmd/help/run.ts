// The `seu help` flow -- renders what the other commands declare about
// themselves.
//
// Nothing about a command is described here: the list comes from the registry,
// each page comes from that command's own const. The only text this file owns
// is what is true of seu as a whole.
//
// Kept apart from the command const in src/cmd/help/index.ts so that the
// command set and its renderer do not import each other.

import { COMMANDS, findCommand } from '../index.ts';
import type { Command } from '../command.ts';
import { LOG } from '../../common/log.ts';

const HEADLINE = 'seu -- Claude Code in a hardware-isolated microVM, with a full build toolchain';
const PROFILE = 'The project seu configuration has to be placed under .seu/config.json.';

const WIDTH = 79;
const INDENT = 22;

/**
 * Wrap `text` into `width` columns, every line after the first indented.
 */
function wrap(text: string, indent: number, width = WIDTH): string {
    const pad = ' '.repeat(indent);
    const lines: string[] = [];

    let line = '';
    for (const word of text.split(/\s+/)) {
        if (line === '') {
            line = word;
        } else if (`${line} ${word}`.length + indent <= width) {
            line += ' ' + word;
        } else {
            lines.push(line);
            line = word;
        }
    }

    if (line !== '') {
        lines.push(line);
    }

    return lines.join(`\n${pad}`);
}

/**
 * `  start [options]  build, install and ...`,
 * wrapped and aligned.
 */
function listEntry(command: Command): string {
    const left = `  ${command.name}${command.args !== undefined ? ` ${command.args}` : ''}`;
    const text = wrap(command.summary, INDENT);
    return left.length + 1 > INDENT
        ? `${left}\n${' '.repeat(INDENT)}${text}`
        : `${left.padEnd(INDENT)}${text}`;
}

function general(): string {
    return [
        HEADLINE,
        '',
        'usage: seu <command> [options]',
        '       seu help [command]',
        '',
        COMMANDS.map(listEntry).join('\n'),
        '',
        PROFILE
    ].join('\n');
}

function page(command: Command): string {
    const parts = [usageLine(command), '', command.summary.charAt(0).toUpperCase() + command.summary.slice(1) + '.'];
    if (command.details) {
        parts.push('', command.details);
    }

    if (command.options?.length) {
        parts.push(
            '',
            'options:',
            command.options.map((o) => `  ${o.flag.padEnd(INDENT - 2)}${wrap(o.text, INDENT)}`).join('\n'),
        );
    }

    return parts.join('\n');
}

/**
 * `seu start [options]` -- the first line of a command's own help page.
 */
function usageLine(command: Command): string {
    return `usage: seu ${command.name}${command.args ? ` ${command.args}` : ''}`;
}

export async function run(argv: string[]): Promise<void> {
    if (argv.length === 0) {
        LOG.print(general());
        return;
    }

    const command = findCommand(argv[0]);
    if (command === undefined) {
        LOG.print(`Unknown command: ${argv[0]}`);
    } else {
        LOG.print(page(command));
    }
}

/**
 * The same text as a refusal: stderr, and the caller picks the exit code.
 */
export function usage(message?: string): void {
    if (message !== undefined) {
        LOG.error(message);
    }

    LOG.print(general());
}
