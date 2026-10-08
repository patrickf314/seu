import { LOG } from '../../common/log.ts';
import { die } from '../../common/error.ts';
import { type Instance, type Project, resolveInstance, resolveProject, seuCommand } from '../../config/project.ts';
import { listForwards, stopAllForwards } from '../../network/forward.ts';
import { parseArgs } from '../../common/args.ts';
import { CONFIG_FILE } from '../../config/config.ts';
import { existsSync } from 'node:fs';
import { sessionSandboxName, sessionStatus, stopSession } from '../../msb/session.ts';

export async function run(argv: string[]): Promise<void> {
    const { name } = parseArgs(argv, { command: 'stop', defaults: {} });

    LOG.step('Metadata')
    const project = await resolveProject();
    const instance = resolveInstance(project, name);
    logMetadata(project, instance);

    const sandbox = sessionSandboxName(instance);
    const status = await sessionStatus(instance);

    if (status === 'absent') {
        die(`${sandbox} does not exist -- nothing to stop`);
    }

    LOG.step(`Stopping ${sandbox}`);
    if (status === 'stopped' || status === 'crashed' || status === 'created') {
        LOG.ok(`${sandbox} is not running (${status})`);
    } else {
        await stopSession(instance);
        LOG.ok('stopped');
    }

    const forwards = listForwards(instance);
    stopAllForwards(instance);
    for (const f of forwards) {
        LOG.ok(`dropped forward ${f.bind}:${f.host} -> vm:${f.guest}`);
    }

    LOG.info(`~/work and every cache are kept in the volume -- \`${seuCommand(instance, 'start')}\` resumes it`);
}

function logMetadata(project: Project, instance: Instance): void {
    LOG.ok(`        Name: ${project.name}`);
    LOG.ok(`        Root: ${project.root}`);
    LOG.ok(`      Config: ${existsSync(project.configFile) ? project.configFile : `no ${CONFIG_FILE} -- using defaults`}`);
    LOG.ok(`    Instance: ${instance.name}`);
}
