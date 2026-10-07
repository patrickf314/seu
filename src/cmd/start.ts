// `seu start`. The flow itself lives in src/cmd/start/run.ts.

import type { Command } from './command.ts';

export const START: Command = {
    name: 'start',
    args: '[name] [options]',
    summary: 'build, install and start a SEU, or resume one that already exists',

    details: `Brings this worktree to a session you can work in, doing only what is still missing.

A worktree can have several SEUs side by side. Each is named -- by default after the worktree's directory -- and has its own session sandbox, its own named volume (and with it its own /work clone, ~/.m2 and Docker images) and its own port forwards. Only the base image is shared. \`seu start review\` next to \`seu start\` gives you a second, independent sandbox of the same checkout; \`seu shell review\` gets you into it.

The steps, each skipped when it is not needed:

  1. Base image. The project's toolchain, installed via mise and built on the host with Docker. Shared by every SEU of the project and only rebuilt when its inputs change or --rebuild asks for it.

  2. Install. A THROWAWAY sandbox with wide egress, over the SEU's named volume. It first fetches what \`image.pre-install\` in .seu/config.json names -- docker images and Maven artifacts -- and then runs \`install.script\` as \`seu\` in /work, with a docker daemon available. Everything lands in the volume, which is the only thing that survives into the session.

  3. Session. The sandbox you work in, created over the same volume with egress narrowed to Anthropic. It is detached: it keeps running when this command returns.

The install and the session cannot be one sandbox: microsandbox fixes a network policy at creation, so the only way to install with a network and then work without one is to hand the volume over.

On a SEU whose session already exists, none of that is repeated: a stopped one is resumed, a running one is left alone. /work and every cache live in the volume, so nothing is lost. Pass --reinstall to run the install again (after changing \`image.pre-install\` or \`install.script\`), or --rebuild after changing the toolchain; both recreate the session sandbox but keep the volume.

A pre-install entry is one of:

  { "type": "docker-compose", "compose": "local/docker-compose.yml" }
      pull every image the compose file names (services it builds are skipped)

  { "type": "docker", "image": "postgres:18" }
      pull one image

  { "type": "maven", "artifact": "org.apache.maven.plugins:maven-failsafe-plugin:3.5.6" }
      resolve one artifact and its dependencies into ~/.m2

The install script is configured as:

  { "install": { "script": "mvn clean install -DskipTests -T1C" } }

Unlike everything else in the profile, \`install.script\` is a shell command by design. It only ever runs inside the guest, in a sandbox that is thrown away afterwards.

Your own ~/.m2/repository is mounted read-only at /host-m2 in the install sandbox and declared there as a \`file://\` repository, ahead of the real remotes. Artifacts you already have -- private ones too -- are copied out of it rather than downloaded, so no credential is needed in there and your ~/.m2/settings.xml is never read. Afterwards the resolution tracking files are cleared and settings.xml is replaced with an offline one, without which the session cannot resolve what was just fetched for it. --no-host-m2 turns it off; SEU_HOST_M2 relocates it.`,

    options: [
        { flag: '--rebuild', text: 'rebuild the base image even when it is loaded; implies --reinstall' },
        { flag: '--reinstall', text: 're-run pre-install and install.script and recreate the session sandbox' },
        { flag: '--no-host-m2', text: 'do not mount the host ~/.m2/repository; download everything instead' },
    ],

    async run(argv: string[]): Promise<void> {
        // Imported here rather than at the top: the flow is what pulls in the
        // microsandbox SDK, and `seu help` must not need it.
        const { run } = await import('./start/run.ts');
        await run(argv);
    },
};
