#!/usr/bin/env python3
"""Project the developer's Claude Code configuration onto the SEU VM.

Everything here runs on the HOST and only ever writes to stdout; seu stages the
result and pushes it into the sandbox. Three documents come out of it:

  settings    ~/.claude/settings.json with the host-only parts removed and the
              VM's own hardening merged ON TOP, so the sandbox always wins.
  statusline  ~/.config/ccstatusline/settings.json with an SEU badge prepended,
              so a VM shell is never mistaken for a host shell.
  identity    the account/onboarding subset of ~/.claude.json, so the VM does
              not re-run onboarding for an account that is already signed in.

No secret passes through here. The OAuth blob goes straight from the macOS
Keychain into the staged file -- see seu_sync_claude_config in lib/common.sh.
"""

import argparse
import json
import sys

# Settings keys that describe the HOST and would be wrong -- or actively broken
# -- inside the VM.
#
#   hooks             point at host binaries (alerter, osascript, terminal-
#                     notifier). In the guest every notification would do
#                     nothing but log "command not found".
#   statusLine        seu writes its own, so the badge is always there.
#   installMethod,    the guest install comes from Anthropic's apt repo and must
#   autoUpdaterStatus never auto-update: a session has no egress for it, and an
#                     update would fight the pinned CLAUDE_CODE_VERSION.
#   *Helper, *Refresh credential helpers that shell out to host-only tooling
#                     (~/.claude/anthropic_key.sh and friends).
HOST_ONLY = (
    "hooks",
    "statusLine",
    "installMethod",
    "autoUpdaterStatus",
    "apiKeyHelper",
    "awsAuthRefresh",
    "awsCredentialExport",
    "otelHeadersHelper",
    "forceLoginMethod",
)

# What is worth carrying from ~/.claude.json. Deliberately a short ALLOW list,
# not a deny list: that file is ~90 keys of cached feature flags, Statsig gates,
# tip counters and per-directory project state, none of which means anything in
# a fresh VM, and some of which (githubRepoPaths, projects) is host filesystem
# layout. Only the account identity and the "you have already been through this"
# flags are useful.
IDENTITY_KEYS = (
    "oauthAccount",
    "userID",
    "anonymousId",
    "hasCompletedOnboarding",
    "lastOnboardingVersion",
    "firstStartTime",
    "hasAvailableSubscription",
    "hasAvailableMaxSubscription",
    "subscriptionNoticeCount",
    "maxSubscriptionNoticeCount",
    "hasOpusPlanDefault",
    "theme",
    "editorMode",
)

# A status line for a developer who has never configured ccstatusline. Same
# shape as the real thing, just shorter.
DEFAULT_STATUSLINE = {
    "version": 4,
    "lines": [
        [
            {"id": "model", "type": "model", "color": "cyan"},
            {"id": "sep-1", "type": "separator"},
            {"id": "ctx", "type": "context-length", "color": "brightBlack"},
        ],
        [
            {"id": "cwd", "type": "current-working-dir"},
            {"id": "sep-2", "type": "separator"},
            {"id": "branch", "type": "git-branch"},
        ],
    ],
    "flexMode": "full-minus-40",
    "colorLevel": 2,
    "defaultPaddingSide": "both",
}

BADGE_ID = "seu-badge"


def load_json(path, default=None):
    """A missing or unparseable file is not fatal: the VM still gets a config,
    it just falls back to the defaults. Complaining on stderr is enough."""
    if not path:
        return default if default is not None else {}
    try:
        with open(path, encoding="utf-8") as fh:
            value = json.load(fh)
    except FileNotFoundError:
        return default if default is not None else {}
    except (OSError, ValueError) as exc:
        print(f"seu: ignoring {path}: {exc}", file=sys.stderr)
        return default if default is not None else {}
    if not isinstance(value, dict):
        print(f"seu: ignoring {path}: not a JSON object", file=sys.stderr)
        return default if default is not None else {}
    return value


def deep_merge(base, over):
    """`over` wins. Dicts merge recursively; lists are UNIONed rather than
    replaced, because the one list that matters here is permissions.deny and
    dropping the host's entries to take the VM's would be a downgrade."""
    out = dict(base)
    for key, value in over.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        elif isinstance(value, list) and isinstance(out.get(key), list):
            merged = list(out[key])
            for item in value:
                if item not in merged:
                    merged.append(item)
            out[key] = merged
        else:
            out[key] = value
    return out


def cmd_settings(args):
    host = load_json(args.host)
    base = load_json(args.base)

    merged = {k: v for k, v in host.items() if k not in HOST_ONLY}
    merged = deep_merge(merged, base)

    if args.statusline:
        # Keep whatever cadence the developer chose; replace only the command,
        # which on the host may be an absolute mise shim path that does not
        # exist in the guest.
        host_sl = host.get("statusLine") if isinstance(host.get("statusLine"), dict) else {}
        merged["statusLine"] = {
            "type": "command",
            "command": "ccstatusline",
            "padding": host_sl.get("padding", 0),
            "refreshInterval": host_sl.get("refreshInterval", 10),
        }

    json.dump(merged, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


def cmd_statusline(args):
    cfg = load_json(args.host, dict(DEFAULT_STATUSLINE))
    lines = cfg.get("lines")
    if not isinstance(lines, list) or not lines:
        lines = [[]]

    first = lines[0] if isinstance(lines[0], list) else []
    # Idempotent: re-running must not stack badges, and the host config may
    # itself be a copy of a previously generated one.
    first = [w for w in first if not (isinstance(w, dict) and w.get("id") == BADGE_ID)]

    badge = [{
        "id": BADGE_ID,
        "type": "custom-text",
        "customText": args.label,
        "color": "green",
        "bold": True,
    }]
    if first:
        badge.append({"id": f"{BADGE_ID}-sep", "type": "separator"})

    cfg["lines"] = [badge + first] + lines[1:]
    # The guest has no npm and no egress for one: the status line is a pinned
    # tarball unpacked into /opt by vm/Dockerfile. Saying so stops ccstatusline
    # from offering to update itself in a session that could never do it.
    cfg["installation"] = {"method": "pinned"}

    json.dump(cfg, sys.stdout, indent=2)
    sys.stdout.write("\n")


def cmd_identity(args):
    host = load_json(args.host)
    out = {k: host[k] for k in IDENTITY_KEYS if k in host}

    # The VM is the isolation boundary, so the in-VM Claude does not need to ask
    # again before running without permission prompts -- that is the whole point
    # of putting it in a microVM with a read-only /src and no egress.
    out["bypassPermissionsModeAccepted"] = True
    out["hasCompletedOnboarding"] = True
    # No egress for it, and it would fight the apt-pinned install.
    out["autoUpdates"] = False

    json.dump(out, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="mode", required=True)

    p = sub.add_parser("settings")
    p.add_argument("--host", required=True, help="the developer's settings.json")
    p.add_argument("--base", required=True, help="vm/claude-settings.json, merged on top")
    p.add_argument("--no-statusline", dest="statusline", action="store_false",
                   help="leave the status line out (ccstatusline is not in the image)")
    p.set_defaults(func=cmd_settings, statusline=True)

    p = sub.add_parser("statusline")
    p.add_argument("--host", required=True, help="the developer's ccstatusline settings.json")
    p.add_argument("--label", required=True, help="badge text, e.g. 'SEU website-react'")
    p.set_defaults(func=cmd_statusline)

    p = sub.add_parser("identity")
    p.add_argument("--host", required=True, help="the developer's ~/.claude.json")
    p.set_defaults(func=cmd_identity)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
