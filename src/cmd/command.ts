/**
 * An interface representing a command option
 */
export interface CommandOption {
    /**
     * As the user types it, e.g. `--no-host-m2`.
     */
    readonly flag: string;

    /**
     * One sentence; wrapped by the help renderer.
     */
    readonly text: string;
}

/**
 * An interface representing a command
 */
export interface Command {
    /**
     * The word after `seu`.
     */
    readonly name: string;

    /**
     * A list of aliases for the command
     */
    readonly aliases?: string[];

    /**
     * Argument shape for the usage line, e.g. `[options]`, `trace <path>`.
     * Used for displaying the usage line in `seu help`
     */
    readonly args?: string;

    /**
     * One line for the command list. Lowercase, no trailing period.
     */
    readonly summary: string;

    /**
     * Prose for `seu help <name>`: what it does and what to know about it.
     */
    readonly details?: string;

    /**
     * Description of the command options
     */
    readonly options?: readonly CommandOption[];

    /**
     * Command main method.
     *
     * Returns the process exit code, or nothing for the usual case where
     * finishing without throwing means success. `shell` is the one that needs
     * it: the exit status of the shell you were just in is its own answer, not
     * seu's.
     *
     * @param argv
     */
    run(argv: string[]): Promise<void | number>;
}
