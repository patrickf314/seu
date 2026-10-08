// `seu shell`. The flow itself lives in src/cmd/shell/run.ts.

import type { Command } from '../command.ts';

export const SHELL: Command = {
    name: 'shell',
    args: '[name]',
    summary: 'attach an interactive shell to the session, in /work',

    details: `Puts you inside the session sandbox of the SEU called <name> -- by default the worktree's own -- as \`seu\`, in /work, in a login bash. This is where you run \`claude\`.

The sandbox has to exist already -- \`seu start\` makes one. A sandbox that is only stopped is started again here, and /work re-prepared, because that costs nothing: the clone and every cache live in the named volume. An absent one is refused rather than created, since creating one means running the project's \`install\` steps.

dockerd is started by this command and supervised by it. The daemon runs in the foreground of a host-side exec (see vm/dockerd-run.sh), and such an exec dies with the process that opened it -- which is why \`seu start\` cannot be the one holding it, and why Docker inside the VM lives exactly as long as your shell does. The sandbox itself does not: leave the shell and it keeps running, with /work and every cache untouched.

Inside, /src is the host worktree mounted READ-ONLY and /work is your writable clone of it. Commit in /work; \`seu pull\` on the host is how the commits come back. Egress is restricted to Anthropic, so nothing in here resolves a dependency that \`seu start\` did not already put in the volume.

Ctrl+] detaches from the terminal session without ending the shell.`,

    async run(argv: string[]): Promise<number> {
        // Imported here rather than at the top: the flow is what pulls in the
        // microsandbox SDK, and `seu help` must not need it.
        const { run } = await import('./run.ts');
        return run(argv);
    },
};
