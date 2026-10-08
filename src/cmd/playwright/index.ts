// `seu playwright`. The flow itself lives in src/cmd/playwright/run.ts.

import type { Command } from '../command.ts';

export const PLAYWRIGHT: Command = {
    name: 'playwright',
    aliases: ['pw'],
    args: '<trace> [options]',
    summary: 'open a Playwright trace from the VM in your browser',

    details: `Starts Playwright's trace viewer INSIDE the VM, forwards its port to your Mac and opens it in your browser. The trace file never leaves the sandbox, and the host needs no node, no npx and no network.

  seu playwright club/club-ui/club-ui-test/target/trace.zip

<trace> is relative to /work; a leading /work/ is accepted too.

The viewer ships inside the Playwright Java client, so it is started with \`mvn -o exec:java\` through the module whose pom puts that client on the classpath. By default that is the nearest pom.xml above the trace -- the test module whose target/ it was written to. If that guess is wrong, pass --pom. Offline, because the session has no network: the exec plugin and Playwright have to be in ~/.m2 already, which an install \`script\` step that builds that module takes care of.

The forward is an ordinary \`seu port\` forward while it lasts. Ctrl-C stops the viewer and drops it.`,

    options: [
        { flag: '--name, -n <name>', text: 'the SEU the trace is in; default: the worktree\'s directory name' },
        { flag: '--port <port>', text: 'host port for the viewer; default: the first free one from 9323 upward' },
        { flag: '--no-open', text: 'print the URL instead of opening it in your browser' },
        { flag: '--pom <path>', text: 'the module pom with Playwright on its classpath; overrides the guess' },
    ],

    async run(argv: string[]): Promise<number | void> {
        // Imported here rather than at the top: the flow is what pulls in the
        // microsandbox SDK, and `seu help` must not need it.
        const { run } = await import('./run.ts');
        return run(argv);
    },
};
