// `.seu/config.json` -- the project profile: what this particular repository
// needs from its sandbox.
//
// It is DATA, never code: seu is meant to distrust the repository it
// sandboxes, so nothing read here is eval'd or word-split into a command, and
// every value that reaches a host command is validated by the schema below
// before anyone sees it.
//
// The whole file is optional. A project without one gets the defaults, which
// are derived from the worktree itself.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { die } from '../common/error.ts';
import type { Project } from './project.ts';

export const CONFIG_FILE = join('.seu', 'config.json');

const DEFAULT_IMAGE = 'seu-vm-image';

const DEFAULT_RESOURCES: Resources = {
    cpus: 4,
    memoryMiB: 10 * 1024,
    rootDiskMiB: 20 * 1024,
    volumeSizeMiB: 20 * 1024,
    idleTimeoutSecs: 60 * 60,
};

/**
 * The one place outside the project a config may name a file in: the host's
 * own Claude Code config. Anything else of the host's stays out of reach of a
 * repository seu does not trust.
 */
const HOME_CLAUDE_DIR = '~/.claude/';

const ProjectPath = z
    .string()
    .refine((p) => !p.startsWith('/'), 'must be relative to the project')
    .refine((p) => !p.split('/').includes('..'), 'must not contain \'..\'')
    .refine((p) => /^(\.\/)?[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(p), 'is not a usable path');

const ClaudeSettingsPath = z
    .string()
    .refine((p) => !p.split('/').includes('..'), 'must not contain \'..\'')
    .refine(
        (p) => p.startsWith(HOME_CLAUDE_DIR) || ProjectPath.safeParse(p).success,
        `must be relative to the project, or a file in ${HOME_CLAUDE_DIR}`,
    );

const PositiveInt = z.number().int().positive();

const ResourcesSchema = z
    .object({
        cpus: PositiveInt.optional(),
        memoryMiB: PositiveInt.optional(),
        rootDiskMiB: PositiveInt.optional(),
        volumeSizeMiB: PositiveInt.optional(),
        idleTimeoutSecs: PositiveInt.optional(),
    })
    .strict();

const ClaudeSchema = z
    .object({
        /**
         * A Claude Code settings file, copied to ~/.claude/settings.json on
         * every `seu start`.
         */
        settings: ClaudeSettingsPath.optional(),

        /**
         * Whether `seu claude` starts claude with
         * --dangerously-skip-permissions.
         */
        dangerouslySkipPermissions: z.boolean().optional(),
    })
    .strict();

const ImageReference = z
    .string()
    .regex(
        /^[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@sha256:[a-f0-9]{64})?$/,
        'must be a docker image reference, e.g. postgres:18',
    );

/**
 * What `dependency:get` would take for a version if it came third.
 */
const PACKAGINGS = new Set(['jar', 'pom', 'war', 'ear', 'maven-plugin', 'test-jar', 'zip', 'aar']);

const MavenCoordinates = z
    .string()
    .regex(
        /^[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+){2,4}$/,
        'must be groupId:artifactId:version[:packaging[:classifier]]',
    )
    .superRefine((c, ctx) => {
        const [g, a, packaging, version, ...rest] = c.split(':');
        if (!PACKAGINGS.has(packaging ?? '')) {
            return;
        }

        const fixed = [g, a, version ?? '<version>', packaging, ...rest].join(':');
        ctx.addIssue({
            code: 'custom',
            message: `the version comes third: groupId:artifactId:version[:packaging[:classifier]] -- did you mean ${fixed}?`,
        });
    });

const DockerStep = z
    .object({
        type: z.literal('docker'),
        image: ImageReference,
    })
    .strict();

const DockerComposeStep = z
    .object({
        type: z.literal('docker-compose'),
        compose: ProjectPath,
    })
    .strict();

const MavenStep = z
    .object({
        type: z.literal('maven'),
        artifact: MavenCoordinates,
    })
    .strict();

const MiseStep = z
    .object({
        type: z.literal('mise'),
        toml: ProjectPath,
    })
    .strict();

const ScriptStep = z
    .object({
        type: z.literal('script'),
        script: z.string().trim().min(1, 'must be a shell command'),
    })
    .strict();

const InstallStepSchema = z.discriminatedUnion('type', [
    DockerStep,
    DockerComposeStep,
    MavenStep,
    MiseStep,
    ScriptStep,
]);

const PortSpec = z.union([
    z.number().int().transform(String),
    z.string().regex(/^[0-9A-Za-z.*]+(:[0-9]+){0,2}$/i, 'must be a port spec, e.g. 8080 or "5173:5173"'),
]);

const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name');

const SecretReference = z
    .string()
    .regex(
        /^op:\/\/[^/\n]+\/[^/\n]+(\/[^/\n]+){1,2}(\?[^\n]*)?$/,
        'must be a 1Password reference, e.g. op://Private/Claude Code/credential',
    );

const SeuConfigSchema = z
    .object({
        /**
         * The microsandbox image every sandbox of the project runs on. It has
         * to be in msb's image store already: seu never builds or loads one.
         */
        image: ImageReference.optional(),

        /**
         * What `seu start` runs in the install sandbox, in the order written,
         * while it still has egress. The session has no network, so this is
         * the only chance anything has to arrive.
         */
        install: z
            .array(InstallStepSchema)
            .refine((steps) => steps.filter((s) => s.type === 'mise').length <= 1, 'at most one mise step')
            .optional(),

        /**
         * What a bare `seu port` forwards: the project's usual dev servers, so
         * nobody has to remember them.
         */
        ports: z.array(PortSpec).optional(),

        /**
         * Environment variables for the session shell, each read from
         * 1Password on the host every time a shell is entered.
         */
        secrets: z.record(EnvName, SecretReference).optional(),

        /**
         * What every sandbox of the project gets: CPUs, memory, root disk and
         * the size of a new volume.
         */
        resources: ResourcesSchema.optional(),

        /**
         * How Claude Code runs in the session.
         */
        claude: ClaudeSchema.optional(),
    })
    .strict();

export type SeuConfigFile = z.infer<typeof SeuConfigSchema>;
export type InstallStep = z.infer<typeof InstallStepSchema>;

export interface Resources {
    readonly cpus: number;
    readonly memoryMiB: number;
    readonly rootDiskMiB: number;

    /**
     * The size of a newly created volume. A clone keeps its template's size.
     */
    readonly volumeSizeMiB: number;

    /**
     * How long a sandbox may sit idle before microsandbox stops it.
     */
    readonly idleTimeoutSecs: number;
}

export interface ClaudeConfig {
    /**
     * Absolute path of the Claude Code settings to copy into the session, or
     * undefined when the project names none.
     */
    readonly settings: string | undefined;

    /**
     * Whether `seu claude` passes --dangerously-skip-permissions.
     */
    readonly dangerouslySkipPermissions: boolean;
}

export interface SeuConfig {
    /**
     * The microsandbox image reference.
     */
    readonly image: string;

    /**
     * Names the project's template: the directory name
     */
    readonly template: string;

    /**
     * In declaration order; empty when the project installs nothing. A mise
     * step's `toml` is absolute.
     */
    readonly install: readonly InstallStep[];

    /**
     * Port specs a bare `seu port` forwards, unparsed; empty when the project
     * names none.
     */
    readonly ports: readonly string[];

    /**
     * Env var name to 1Password reference, unresolved; empty when the project
     * names none.
     */
    readonly secrets: Readonly<Record<string, string>>;

    readonly resources: Resources;

    readonly claude: ClaudeConfig;
}

/**
 * Read, validate and resolve the project profile.
 *
 * Resolution is part of loading on purpose: everything downstream wants
 * absolute paths and a name it can hand to docker, and nothing downstream
 * should have to know what the defaults were.
 */
export function loadConfig(project: Project): SeuConfig {
    const config = parseConfig(project.configFile);

    return {
        image: config.image ?? DEFAULT_IMAGE,
        template: templateName(project),
        install: (config.install ?? []).map(step => validateInstallStep(project, step)),
        ports: config.ports ?? [],
        secrets: config.secrets ?? {},
        resources: { ...DEFAULT_RESOURCES, ...config.resources },
        claude: {
            settings: config.claude?.settings === undefined
                ? undefined
                : claudeSettingsFile(project, config.claude.settings),
            dangerouslySkipPermissions: config.claude?.dangerouslySkipPermissions ?? true,
        },
    };
}

function parseConfig(file: string): SeuConfigFile {
    if (!existsSync(file)) {
        return {};
    }

    let json: unknown;
    try {
        json = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
        die(`${file}: not valid JSON\n    ${(err as Error).message}`);
    }

    const result = SeuConfigSchema.safeParse(json);
    if (result.success) {
        return result.data;
    }

    const issues = result.error.issues.map((issue) => {
        const path = issue.path
            .map((key, i) => (typeof key === 'number' ? `[${key}]` : `${i === 0 ? '' : '.'}${String(key)}`))
            .join('');
        return `${path || '(top level)'}: ${issue.message}`;
    });
    die(`${file}: invalid\n    ${issues.join('\n    ')}`);
}

function templateName(project: Project): string {
    const name = project.name.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
    if (!/^[a-z0-9]/.test(name)) {
        die(`cannot derive a template name from the directory name ${project.name}`);
    }
    return name;
}

function validateInstallStep(project: Project, step: InstallStep): InstallStep {
    if (step.type === 'mise') {
        return { ...step, toml: projectFile(project, 'install mise step', step.toml) };
    }

    return step;
}

/**
 * The absolute path of a file the config names, which has to exist.
 */
function projectFile(project: Project, what: string, file: string): string {
    return existingFile(project, what, file, join(project.root, file.replace(/^\.\//, '')));
}

/**
 * A settings file in the project, or one in the host's ~/.claude.
 */
function claudeSettingsFile(project: Project, file: string): string {
    if (file.startsWith(HOME_CLAUDE_DIR)) {
        return existingFile(project, 'claude.settings', file, join(homedir(), file.slice(2)));
    }
    return projectFile(project, 'claude.settings', file);
}

function existingFile(project: Project, what: string, file: string, path: string): string {
    if (!existsSync(path) || !statSync(path).isFile()) {
        die(`${project.configFile}: ${what}: ${file} does not exist`);
    }
    return path;
}
