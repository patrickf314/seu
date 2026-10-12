// `seu claude`. The flow itself lives in src/cmd/claude/run.ts.

import type { Command } from '../command.ts';

export const CLAUDE: Command = {
    name: 'claude',
    args: '[--name <name>] [-- <claude args>]',
    summary: 'start claude in the session, in ~/work, by default without permission prompts',

    details: `Like \`seu shell\`, but instead of bash you land directly in \`claude\`, as \`seu\`, in ~/work. Everything \`seu shell\` says about the sandbox, dockerd and ~/work holds here too.

claude runs with --dangerously-skip-permissions, unless \`claude.dangerouslySkipPermissions\` in .seu/config.json is false. The microVM is the isolation boundary: /src is mounted read-only, egress is restricted to Anthropic, and the only way work leaves is \`seu pull\` on the host. Prompting for every command inside it adds friction, not safety.

With \`claude.model\` set in .seu/config.json, e.g. to \`opus\`, claude is started with --model and that value.

Anything after \`--\` is passed to claude as it is, e.g. \`seu claude -- --continue\`.

Leaving claude leaves the session running.`,

    options: [
        { flag: '--name, -n <name>', text: 'the SEU to start claude in; default: the worktree\'s directory name' },
    ],

    async run(argv: string[]): Promise<number> {
        // Imported here rather than at the top: the flow is what pulls in the
        // microsandbox SDK, and `seu help` must not need it.
        const { run } = await import('./run.ts');
        return run(argv);
    },
};
