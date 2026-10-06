// `seu build`. The flow itself lives in src/build/run.ts.

import type { Command } from './command.ts';

export const BUILD: Command = {
    name: 'build',
    args: '[options]',
    summary: 'create the base image and pre-install what the project needs',
    details: `Builds the base image for the SEU: the project's build and working tools, installed via mise.

Then, in a throwaway sandbox that still has network access, it fetches everything \`image.pre-install\` in .seu/config.json names into the project's named volume -- docker images and Maven artifacts. The session sandbox has no egress, so whatever is not pre-installed here is not available there.

A pre-install entry is one of:

  { "type": "docker", "compose": "local/docker-compose.yml" }
      pull every image the compose file names (services it builds are skipped)

  { "type": "docker", "image": "postgres:18" }
      pull one image

  { "type": "maven", "artifact": "org.apache.maven.plugins:maven-failsafe-plugin:3.5.6" }
      resolve one artifact and its dependencies into ~/.m2`,

    options: [
        { flag: '--rebuild', text: 'rebuild the base image even when it is already loaded' },
    ],

    async run(argv: string[]): Promise<void> {
        // Imported here rather than at the top: the flow is what pulls in the
        // microsandbox SDK, and `seu help` must not need it.
        const { run } = await import('./build/run.ts');
        await run(argv);
    },
};
