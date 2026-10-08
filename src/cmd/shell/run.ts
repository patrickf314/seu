// The `seu shell` flow: find the session, give it a Docker daemon, hand over
// the terminal.
//
// Kept apart from the command const in src/cmd/shell.ts so that loading the
// command set does not load the microsandbox SDK.

import { LOG } from '../../common/log.ts';
import { type Instance, type Project, resolveInstance, resolveProject } from '../../config/project.ts';
import { requireSession } from '../../session.ts';
import { parseArgs } from '../../common/args.ts';
import { CONFIG_FILE, loadConfig } from '../../config/config.ts';
import { existsSync } from 'node:fs';
import { shell } from '../../msb/shell.ts';

export async function run(argv: string[]): Promise<number> {
    const { name } = parseArgs(argv, { command: 'shell', defaults: {} });

    const project = await resolveProject();
    const config = loadConfig(project);
    const instance = resolveInstance(project, name);
    const session = await requireSession(instance);

    LOG.step('Metadata')
    logMetadata(project, instance);

    LOG.step(`Attach with ${session.name}`);
    return await shell(config, session);
}

function logMetadata(project: Project, instance: Instance): void {
    LOG.ok(`Project Name: ${project.name}`);
    LOG.ok(`Project Root: ${project.root}`);
    LOG.ok(`      Config: ${existsSync(project.configFile) ? project.configFile : `no ${CONFIG_FILE} -- using defaults`}`);
    LOG.ok(`    Instance: ${instance.name}`);
}
