import { die } from './error.ts';

/**
 * What a flag does to the options: either the fields it sets (`{ yes: true }`),
 * or a function for anything more. `value()` takes the argument after the flag,
 * and dies if there is none.
 */
export type FlagAction<T> = Partial<T> | ((opts: T, value: () => string) => void);

export interface ArgSpec<T extends object> {
    /**
     * The command name, for error messages.
     */
    readonly command: string;

    /**
     * The options before any flag has been seen. Must be a fresh object per call.
     */
    readonly defaults: T;

    /**
     * Every flag the command knows, aliases included (`--yes` and `-y`).
     */
    readonly flags?: Readonly<Record<string, FlagAction<T>>>;

    /**
     * Handles an argument that is not a flag. Without it, the command takes no
     * arguments.
     */
    readonly positional?: (opts: T, arg: string) => void;

    /**
     * Whether the command works on one SEU and takes `--name`. Defaults to true.
     */
    readonly instance?: boolean;
}

export interface InstanceOptions {
    name: string | undefined;
}

/**
 * Parse a command's argv against its spec. `--name` is handled here for every
 * command that works on a SEU, so that it means the same everywhere.
 */
export function parseArgs<T extends object>(argv: readonly string[], spec: ArgSpec<T>, instance: false): T;
export function parseArgs<T extends object>(argv: readonly string[], spec: ArgSpec<T>, instance?: true): T & InstanceOptions;
export function parseArgs<T extends object>(argv: readonly string[], spec: ArgSpec<T>, instance = true): (T & InstanceOptions) | T {
    const { name, rest } = instance ? extractInstanceNameFromArgv(argv) : { name: undefined, rest: [...argv] };
    const opts = spec.defaults;

    for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];

        if (!arg.startsWith('-')) {
            if (spec.positional === undefined) {
                die(`${spec.command} takes no arguments, not ${arg} -- name a SEU with --name`);
            }
            spec.positional(opts, arg);
            continue;
        }

        const action = spec.flags !== undefined && Object.hasOwn(spec.flags, arg) ? spec.flags[arg] : undefined;
        if (action === undefined) {
            die(`unknown option for ${spec.command}: ${arg}`);
        }

        if (typeof action === 'function') {
            action(opts, () => rest[++i] ?? die(`${arg} needs a value`));
        } else {
            Object.assign(opts, action);
        }
    }

    return { ...opts, name };
}

/**
 * Take `--name <name>` (or `-n <name>`, or `--name=<name>`) out of a command's argv.
 */
export function extractInstanceNameFromArgv(argv: readonly string[]): { name: string | undefined; rest: string[] } {
    let name: string | undefined;
    const rest: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        let value: string | undefined;
        if (arg === '--name' || arg === '-n') {
            value = argv[++i];
            if (value === undefined || value.startsWith('-')) {
                die(`${arg} needs a SEU name`);
            }
        } else if (arg.startsWith('--name=')) {
            value = arg.slice('--name='.length);
        } else {
            rest.push(arg);
            continue;
        }

        if (name !== undefined && name !== value) {
            die(`one SEU at a time, got ${name} and ${value}`);
        }

        name = value;
    }

    return { name, rest };
}

/**
 * Remove the global `--config <path>` / `--config=<path>` from argv, wherever
 * it stands, and return its value.
 */
export function extractConfigPathFromArgv(argv: string[]): { argv: string[]; config: string | undefined } {
    const rest: string[] = [];
    let config: string | undefined;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === '--config') {
            const value = argv[++i];
            if (value === undefined || value === '') {
                die('--config needs a path');
            }
            config = value;
        } else if (arg.startsWith('--config=')) {
            config = arg.slice('--config='.length);
            if (config === '') {
                die('--config needs a path');
            }
        } else {
            rest.push(arg);
        }
    }

    return { argv: rest, config };
}
