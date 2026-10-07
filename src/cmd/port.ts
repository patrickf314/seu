// `seu port`. The flow itself lives in src/cmd/port/run.ts.

import type { Command } from './command.ts';

export const PORT: Command = {
    name: 'port',
    args: '[--name <name>] [spec...]',
    summary: 'forward host ports into the running session, docker-style',

    details: `Makes something listening inside the VM reachable from the Mac. Without --name it forwards into the worktree's default SEU.

  seu port                     list the active forwards
  seu port 8080                shorthand for 8080:8080
  seu port 80:80 8080:8080     HOST:GUEST, like docker
  seu port 0.0.0.0:8080:8080   BIND:HOST:GUEST

The default bind is 127.0.0.1, so a forward is not published to your network unless you ask for it with an explicit bind or \`*:\`.

A forward is an SSH tunnel against the live sandbox, not a published port: microsandbox fixes a sandbox's ports at creation, so publishing one would mean re-creating the session -- root disk gone, every running process killed -- every time you want to look at a dev server. A tunnel can be added or dropped at any moment and nothing in the VM restarts.

They do NOT survive the sandbox stopping, and nothing recreates them: a tunnel into a stopped sandbox has nothing on the other end. Listing is the one mode that works on a stopped session, and it prunes the forwards that died with it.

Every spec is validated before any tunnel starts, so a typo in the last one does not leave half of them up.`,

    options: [
        { flag: '--name, -n <name>', text: 'the SEU to forward into; default: the worktree\'s directory name' },
        { flag: '--stop <host-port>', text: 'drop the forward on that host port; may be repeated' },
        { flag: '--stop-all', text: 'drop every forward of this SEU' },
    ],

    async run(argv: string[]): Promise<void> {
        // Imported here rather than at the top: the flow is what pulls in the
        // microsandbox SDK, and `seu help` must not need it.
        const { run } = await import('./port/run.ts');
        await run(argv);
    },
};
