// `seu start`. The flow itself lives in src/cmd/start/run.ts.

import type { Command } from '../command.ts';

export const START: Command = {
    name: 'start',
    args: '[options]',
    summary: 'start a SEU and open a shell in it, creating it from the project template if needed',

    details: `Brings this worktree to a shell in a running session, doing only what is still missing.

A worktree can have several SEUs side by side. Each is named -- by default after the worktree's directory -- and has its own session sandbox, its own named volume (and with it its own /work clone, ~/.m2 and Docker images) and its own port forwards. \`seu start --name review\` next to \`seu start\` gives you a second, independent sandbox of the same checkout.

What happens depends on what is already there:

  session exists    it is resumed if stopped, left alone if running
  volume exists     a new session over it (after \`seu remove --keep-volume\`)
  neither           the SEU is created from the project's TEMPLATE

The template is a volume that has been installed once -- the \`install\` steps run -- and every new SEU of the project starts as a copy of it. The copy is an APFS clone of the volume's disk image: it takes milliseconds and no disk space until the two diverge. So installing, the slow part, happens once per project rather than once per SEU. The template is named after the worktree's directory. The new SEU's /work is then moved onto this worktree -- its branch, its commit, its uncommitted changes -- keeping the template's build outputs (target/, node_modules), so the first build is incremental.

There is no template yet the first time; \`seu start\` builds it then:

  1. Image. \`image\` in .seu/config.json, by default seu-vm-image. It must already be in microsandbox's image store (\`msb image ls\`); seu never builds or loads it.

  2. Install into the template volume, in a THROWAWAY sandbox with wide egress. It runs the \`install\` steps of .seu/config.json in the order written -- the toolchain, docker images, Maven artifacts, scripts -- as \`seu\`, with a docker daemon available when a step needs one.

The SEU itself never installs: its session only ever has egress to Anthropic. microsandbox fixes a network policy at creation, which is why the install has a sandbox -- and now a volume -- of its own.

--reinstall rebuilds the template from this worktree, and recreates this SEU from the new template. That is how a changed image, mise.toml or install step -- or a new dependency -- gets in. It replaces the SEU's volume, so it first checks /work for work the host does not have (uncommitted changes, commits never \`seu pull\`ed) and refuses if there is any, unless --force. Other SEUs keep their volumes; they are independent copies.

The command ends in the SEU's shell, like \`seu shell\`. Leaving the shell leaves the session running. --detach, or running without a terminal, stops before that.

An install step is one of:

  { "type": "mise", "toml": "./mise.toml" }
      install the toolchain the file names (at most one)

  { "type": "docker-compose", "compose": "local/docker-compose.yml" }
      pull every image the compose file names (services it builds are skipped)

  { "type": "docker", "image": "postgres:18" }
      pull one image

  { "type": "maven", "artifact": "org.apache.maven.plugins:maven-failsafe-plugin:3.5.6" }
      resolve one artifact and its dependencies into ~/.m2

  { "type": "script", "script": "mvn clean install -DskipTests -T1C" }
      run a shell command as \`seu\` in /work

Unlike everything else in the profile, a script step is a shell command by design. It only ever runs inside the guest, in a sandbox that is thrown away afterwards.

Your own ~/.m2/repository is mounted read-only at /host-m2 in the install sandbox and declared there as a \`file://\` repository, ahead of the real remotes. Artifacts you already have -- private ones too -- are copied out of it rather than downloaded, so no credential is needed in there and your ~/.m2/settings.xml is never read. Afterwards the resolution tracking files are cleared and settings.xml is replaced with an offline one, without which the session cannot resolve what was just fetched for it. --no-host-m2 turns it off; SEU_HOST_M2 relocates it.`,

    options: [
        { flag: '--name, -n <name>', text: 'the SEU to start; default: the worktree\'s directory name' },
        { flag: '--reinstall', text: 'rebuild the template, and recreate this SEU from it' },
        { flag: '--force', text: 'with --reinstall: discard work in /work that the host does not have' },
        { flag: '--detach, -d', text: 'start the session but do not open a shell in it' },
        { flag: '--no-host-m2', text: 'do not mount the host ~/.m2/repository when building the template' },
    ],

    async run(argv: string[]): Promise<number> {
        // Imported here rather than at the top: the flow is what pulls in the
        // microsandbox SDK, and `seu help` must not need it. Returns what the
        // shell it ends in exited with.
        const { run } = await import('./run.ts');
        return run(argv);
    },
};
