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
import { die } from '../common/error.ts';
import type { Project } from './project.ts';

export const CONFIG_FILE = join('.seu', 'config.json');

const DEFAULT_IMAGE = 'seu-vm-image';

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

/**
 * The one value in this file that is meant to BE a command. Everything else is
 * validated into a shape no shell can misread; this is handed to `bash -lc` as
 * written, because "build this project" has no smaller vocabulary than the
 * project's own build tool. It only ever runs inside the guest, as `seu`, in a
 * sandbox that is thrown away afterwards -- the host never sees it.
 */
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
export type InstallStep = z.infer<typeof InstallStepSchema>;

export interface SeuConfig {
    /**
     * The config file, or undefined when the project has none.
     */
    readonly file: string | undefined;

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
        image: config.image ?? DEFAULT_IMAGE,
        template: templateName(project),
        install: (config.install ?? []).map((step) => (step.type === 'mise' ? resolveMise(project, file, step) : step)),
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

    // `install[5].artifact: the version comes third ...`, one per
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
 * volume name cannot hold -- `Projekte/Private/website-react` becomes
 * `website-react`.
 */
function templateName(project: Project): string {
    const name = project.name.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
    if (!/^[a-z0-9]/.test(name)) {
        die(`cannot derive a template name from the directory name ${project.name}`);
    }
    return name;
}

/**
 * The mise step's `toml`, made absolute. Configured-but-absent is a typo, not
 * a project without a toolchain, so it fails rather than silently producing a
 * JDK-less template.
 */
function resolveMise(project: Project, file: string, step: InstallStep & { type: 'mise' }): InstallStep {
    const path = join(project.root, step.toml.replace(/^\.\//, ''));
    if (!existsSync(path) || !statSync(path).isFile()) {
        die(`${file}: install mise step: ${step.toml} does not exist`);
    }
    return { ...step, toml: path };
}
