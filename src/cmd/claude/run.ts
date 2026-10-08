import { LOG } from '../../common/log.ts';
import { type Instance, type Project, resolveInstance, resolveProject } from '../../config/project.ts';
import { resumeSession } from '../../msb/session.ts';
import { parseArgs } from '../../common/args.ts';
import { CONFIG_FILE, loadConfig } from '../../config/config.ts';
import { claude } from '../../msb/shell.ts';
import { existsSync } from 'node:fs';

export async function run(argv: string[]): Promise<number> {
    // Everything after `--` belongs to claude, not to seu.
    const split = argv.indexOf('--');
    const own = split === -1 ? argv : argv.slice(0, split);
    const claudeArgs = split === -1 ? [] : argv.slice(split + 1);

    const { name } = parseArgs(own, { command: 'claude', defaults: {} });

    LOG.step('Metadata');
    const project = await resolveProject();
    const config = loadConfig(project);
    const instance = resolveInstance(project, name);
    logMetadata(project, instance);

    LOG.step(`Claude in ${instance.name}`);
    const session = await resumeSession(instance);
    return await claude(config, session, claudeArgs);
}

function logMetadata(project: Project, instance: Instance): void {
    LOG.ok(`        Name: ${project.name}`);
    LOG.ok(`        Root: ${project.root}`);
    LOG.ok(`      Config: ${existsSync(project.configFile) ? project.configFile : `no ${CONFIG_FILE} -- using defaults`}`);
    LOG.ok(`    Instance: ${instance.name}`);
}
