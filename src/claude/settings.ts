// The project's Claude Code settings, carried into the session.
//
// `claudeSettings` in .seu/config.json names a settings file in the project. It
// is copied to ~/.claude/settings.json on every `seu start`, so an edit reaches
// the session without rebuilding the template. Without one the
// session runs on Claude Code's defaults.

import type { Sandbox } from 'microsandbox';
import { readFileSync } from 'node:fs';
import type { SeuConfig } from '../config/config.ts';
import { LOG } from '../common/log.ts';
import { execInSandbox } from '../msb/exec.ts';

const SETTINGS_PATH = '$CLAUDE_CONFIG_DIR/settings.json';

/**
 * Copy the configured settings into the sandbox; nothing when there are none.
 */
export async function installClaudeSettings(sandbox: Sandbox, config: SeuConfig): Promise<void> {
    if (config.claudeSettings === undefined) {
        LOG.debug('no claudeSettings configured');
        return;
    }

    const result = await execInSandbox(sandbox, {
        // Through the environment, not a heredoc: the file is the project's,
        // and none of it should have to survive a shell.
        cmd: 'bash',
        args: [
            '-lc',
            `mkdir -p "$CLAUDE_CONFIG_DIR" && printf '%s' "$SEU_CLAUDE_SETTINGS" > "${SETTINGS_PATH}"`,
        ],
        env: { SEU_CLAUDE_SETTINGS: readFileSync(config.claudeSettings, 'utf8') },
        timeoutMs: 60_000,
    });
    if (result.ok) {
        LOG.ok(`${config.claudeSettings} -> ~/.claude/settings.json`);
    } else {
        LOG.warn(`could not copy ${config.claudeSettings} to ~/.claude/settings.json`);
    }
}
