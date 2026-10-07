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
import { join } from 'node:path';
import { z } from 'zod';
import { LOG } from '../common/log.ts';
import { die } from '../common/error.ts';
import type { Project } from './project.ts';

export const CONFIG_FILE = join('.seu', 'config.json');

const DEFAULT_MISE_TOML = './mise.toml';

const RepositoryName = z
    .string()
    .regex(/^[a-z0-9][a-z0-9._/-]*$/, 'must be a lowercase docker repository name');

const ProjectPath = z
    .string()
    .refine((p) => !p.startsWith('/'), 'must be relative to the project')
    .refine((p) => !p.split('/').includes('..'), 'must not contain \'..\'')
    .refine((p) => /^(\.\/)?[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(p), 'is not a usable path');

const ImageReference = z
    .string()
    .regex(
        /^[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@sha256:[a-f0-9]{64})?$/,
        'must be a docker image reference, e.g. postgres:18',
    );

/** What `dependency:get` would take for a version if it came third. */
const PACKAGINGS = new Set(['jar', 'pom', 'war', 'ear', 'maven-plugin', 'test-jar', 'zip', 'aar']);

const MavenCoordinates = z
    .string()
    .regex(
        /^[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+){2,4}$/,
        'must be groupId:artifactId:version[:packaging[:classifier]]',
    )
    // The order Gradle and most docs print -- g:a:packaging:version -- is the
    // wrong one here, and Maven's own complaint about it comes much later and
    // much less clearly ("version jar not found").
    .superRefine((c, ctx) => {
        const [g, a, packaging, version, ...rest] = c.split(':');
        if (!PACKAGINGS.has(packaging ?? '')) return;
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

const PreInstallStepSchema = z.discriminatedUnion('type', [DockerStep, DockerComposeStep, MavenStep]);

/**
 * The one value in this file that is meant to BE a command. Everything else is
 * validated into a shape no shell can misread; this is handed to `bash -lc` as
 * written, because "build this project" has no smaller vocabulary than the
 * project's own build tool. It only ever runs inside the guest, as `seu`, in a
 * sandbox that is thrown away afterwards -- the host never sees it.
 */
const InstallScript = z.string().min(1, 'must be a shell command');

/**
 * A `seu port` spec, as on the command line: `8080`, `"5173:5173"`,
 * `"0.0.0.0:8080:8080"`. Only the shape is checked here; `seu port` parses it
 * properly before any tunnel starts.
 */
const PortSpec = z.union([
    z.number().int().transform(String),
    z.string().regex(/^[0-9A-Za-z.*]+(:[0-9]+){0,2}(\/tcp)?$/i, 'must be a port spec, e.g. 8080 or "5173:5173"'),
]);

const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name');

/**
 * A 1Password secret reference, `op://vault/item/[section/]field`. Only
 * references are accepted, never values: this file is committed, and a token
 * pasted into it would be too.
 */
const SecretReference = z
    .string()
    .regex(
        /^op:\/\/[^/\n]+\/[^/\n]+(\/[^/\n]+){1,2}(\?[^\n]*)?$/,
        'must be a 1Password reference, e.g. op://Private/Claude Code/credential',
    );

const SeuConfigSchema = z
    .object({
        image: z
            .object({
                /**
                 * Base-image repository name. Default: the worktree's own name, so
                 * two repositories never share (and invalidate) each other's image.
                 */
                tag: RepositoryName.optional(),
                /**
                 * The mise toolchain file to bake into the image. Default
                 * `./mise.toml`; a project without one gets no managed JDK/Maven.
                 */
                'mise-toml': ProjectPath.optional(),
                /**
                 * What `seu start` fetches into the named volume once the image is
                 * up, in the order written. The session has no egress, so this is the
                 * only chance anything here has to arrive.
                 */
                'pre-install': z.array(PreInstallStepSchema).optional(),
            })
            .strict()
            .optional(),

        install: z
            .object({
                /**
                 * What `seu start` runs once the install sandbox is up and still has build
                 * egress: the project's own "make this checkout buildable" command.
                 * Omitted means there is nothing to do and the session starts
                 * straight away.
                 */
                script: InstallScript.optional(),
            })
            .strict()
            .optional(),

        playwright: z
            .object({
                /**
                 * The module whose pom puts the Playwright Java client on the
                 * classpath. `seu playwright` runs Playwright's own CLI through
                 * it, because the CLI -- trace viewer included -- ships inside
                 * that jar and nowhere else in the VM.
                 */
                pom: ProjectPath.optional(),
            })
            .strict()
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
    })
    .strict();

export type SeuConfigFile = z.infer<typeof SeuConfigSchema>;
export type PreInstallStep = z.infer<typeof PreInstallStepSchema>

export interface SeuConfig {
    /**
     * The config file, or undefined when the project has none.
     */
    readonly file: string | undefined;

    readonly image: {
        /**
         * Validated repository name
         */
        readonly tag: string;

        /**
         * Absolute path of the mise config, or null when there is none.
         */
        readonly miseToml: string;

        /**
         * In declaration order; empty when the project pre-installs nothing.
         */
        readonly preInstall: readonly PreInstallStep[];
    };

    readonly install: {
        /**
         * The shell command `seu start` runs, or undefined when the project
         * configures none.
         */
        readonly script: string | undefined;
    };

    readonly playwright: {
        /**
         * Relative to the worktree, without a leading `./`; undefined when the
         * project names none.
         */
        readonly pom: string | undefined;
    };

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
}

/**
 * Read, validate and resolve the project profile.
 *
 * Resolution is part of loading on purpose: everything downstream wants
 * absolute paths and a name it can hand to docker, and nothing downstream
 * should have to know what the defaults were.
 */
export function loadConfig(project: Project): SeuConfig {
    const file = join(project.root, CONFIG_FILE);
    const configFileExists = existsSync(file);
    const config = configFileExists ? parse(file) : {};

    return {
        file: configFileExists ? file : undefined,
        image: {
            tag: config.image?.tag ?? defaultTag(project),
            miseToml: resolveMiseToml(project, file, config.image?.['mise-toml']),
            preInstall: config.image?.['pre-install'] ?? []
        },
        install: {
            script: config.install?.script?.trim() || undefined,
        },
        playwright: {
            pom: config.playwright?.pom?.replace(/^\.\//, ''),
        },
        ports: config.ports ?? [],
        secrets: config.secrets ?? {},
    };
}

function parse(file: string): SeuConfigFile {
    let json: unknown;
    try {
        json = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
        die(`${file}: not valid JSON\n    ${(err as Error).message}`);
    }

    const result = SeuConfigSchema.safeParse(json);
    if (result.success) return result.data;

    // `image.pre-install[5].artifact: the version comes third ...`, one per
    // problem: the path is what tells you which line of the file to look at.
    const issues = result.error.issues.map((issue) => {
        const path = issue.path
            .map((key, i) => (typeof key === 'number' ? `[${key}]` : `${i === 0 ? '' : '.'}${String(key)}`))
            .join('');
        return `${path || '(top level)'}: ${issue.message}`;
    });
    die(`${file}: invalid\n    ${issues.join('\n    ')}`);
}

/**
 * The worktree's own directory name, lowercased and stripped of anything a
 * docker repository name cannot hold -- `Projekte/Private/website-react`
 * becomes `website-react`.
 */
function defaultTag(project: Project): string {
    const tag = project.name.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
    if (!/^[a-z0-9]/.test(tag)) {
        die(`cannot derive an image tag from the directory name ${project.name}`);
    }
    return tag;
}

/**
 * Configured-but-absent is a typo, not a project without a toolchain, so it
 * warns rather than silently producing a JDK-less image. The default path
 * missing simply means this project manages no toolchain.
 */
function resolveMiseToml(project: Project, file: string, configured: string | undefined): string {
    const rel = (configured ?? DEFAULT_MISE_TOML).replace(/^\.\//, '');
    const path = join(project.root, rel);
    if (existsSync(path) && statSync(path).isFile()) {
        return path;
    }

    if (configured !== undefined) {
        LOG.warn(`${file}: image.mise-toml points at ${configured}, which does not exist`);
    }

    die(`Missing mise.toml: ${DEFAULT_MISE_TOML} is the default, or configure image.mise-toml to point at a valid file.`);
}
