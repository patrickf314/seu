// The project's Claude Code settings, carried into the session.
//
// `claude.settings` in .seu/config.json names a settings file in the project or
// in the host's ~/.claude. It is copied to ~/.claude/settings.json on every
// `seu start`, so an edit reaches the session without rebuilding the template.
// Without one the session runs on Claude Code's defaults.
//
// Either way the image's ccstatusline is wired in as the status line, unless
// the settings already name one: the image bakes it in, but Claude Code only
// runs it when `statusLine` says so.

import type { Sandbox } from 'microsandbox';
import { readFileSync } from 'node:fs';
import type { SeuConfig } from '../config/config.ts';
import { LOG } from '../common/log.ts';
import { execInSandbox } from '../msb/exec.ts';
import defaultStatusline from '../../config/ccstatusline-config.json' with { type: 'json' };

const SETTINGS_PATH = '$CLAUDE_CONFIG_DIR/settings.json';

const STATUS_LINE = { type: 'command', command: 'ccstatusline', padding: 0 };

/**
 * Copy the configured settings (or just the status line) into the sandbox.
 */
export async function installClaudeSettings(sandbox: Sandbox, config: SeuConfig, name: string): Promise<void> {
    await installStatusline(sandbox, config, name);

    const settings = config.claude.settings;
    if (settings === undefined) {
        LOG.debug('no claude.settings configured');
    }

    const content = withStatusLine(
        settings === undefined ? undefined : readFileSync(settings, 'utf8'),
        settings ?? 'claude.settings',
    );
    const label = settings ?? 'status line';

    const result = await execInSandbox(sandbox, {
        // Through the environment, not a heredoc: the file is the project's,
        // and none of it should have to survive a shell.
        cmd: 'bash',
        args: [
            '-lc',
            `mkdir -p "$CLAUDE_CONFIG_DIR" && printf '%s' "$SEU_CLAUDE_SETTINGS" > "${SETTINGS_PATH}"`,
        ],
        env: { SEU_CLAUDE_SETTINGS: content },
        timeoutMs: 60_000,
    });
    if (result.ok) {
        LOG.ok(`${label} -> ~/.claude/settings.json`);
    } else {
        LOG.warn(`could not copy ${label} to ~/.claude/settings.json`);
    }
}

const STATUSLINE_PATH = '$HOME/.config/ccstatusline/settings.json';

/**
 * Install the ccstatusline layout: `claude.statusline` as it is, or else the
 * bundled default with a `SEU: <name>` badge first on the first line.
 */
async function installStatusline(sandbox: Sandbox, config: SeuConfig, name: string): Promise<void> {
    const override = config.claude.statusline;
    let content: string;
    if (override !== undefined) {
        content = readFileSync(override, 'utf8');
    } else {
        // Pinned: nothing in a session could update ccstatusline anyway.
        const layout = structuredClone(defaultStatusline) as {
            lines: Record<string, unknown>[][];
            installation: Record<string, unknown>;
        };
        layout.installation.method = 'pinned';
        const badge = { id: 'seu-badge', type: 'custom-text', customText: `SEU: ${name}`, color: 'green', bold: true };
        const separator = { id: 'seu-badge-separator', type: 'separator' };
        layout.lines[0] = [badge, separator, ...(layout.lines[0] ?? [])];
        content = JSON.stringify(layout, null, 2) + '\n';
    }

    const result = await execInSandbox(sandbox, {
        cmd: 'bash',
        args: [
            '-lc',
            `mkdir -p "$(dirname "${STATUSLINE_PATH}")" && printf '%s' "$SEU_STATUSLINE" > "${STATUSLINE_PATH}"`,
        ],
        env: { SEU_STATUSLINE: content },
        timeoutMs: 60_000,
    });
    const label = override ?? 'default status line';
    if (result.ok) {
        LOG.ok(`${label} -> ~/.config/ccstatusline/settings.json`);
    } else {
        LOG.warn(`could not install ${label} to ~/.config/ccstatusline/settings.json`);
    }
}

function withStatusLine(text: string | undefined, source: string): string {
    let settings: Record<string, unknown> = {};
    if (text !== undefined) {
        try {
            settings = JSON.parse(text);
        } catch (error) {
            throw new Error(`${source} is not valid JSON: ${(error as Error).message}`);
        }
    }
    return JSON.stringify({ statusLine: STATUS_LINE, ...settings }, null, 2) + '\n';
}
