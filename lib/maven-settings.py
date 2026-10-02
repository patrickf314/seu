"""Generate the in-VM Maven settings.xml, and extract credentials for `msb exec -e`.

`seu build` needs two things out of the developer's ~/.m2/settings.xml:

  --emit-settings   a settings.xml for the VM that reproduces the host's
                    repository configuration but contains NO secret -- every
                    <server> gets ${env.SEU_MVN_<ID>_USER/_PASS} placeholders --
                    plus a file:///host-m2 repository pointing at the host's
                    Maven repository, mounted read-only into the build sandbox.

  --emit-env        the matching SEU_MVN_<ID>_USER=... / _PASS=... assignments,
                    on stdout only. They go straight into `msb exec -e` and are
                    never written to disk, on the host or in the VM.

The output is REBUILT from extracted pieces rather than edited in place, so
nothing from the host file is carried over unless it is explicitly understood:

  * <properties> inside <profiles> are dropped -- that is where people keep
    tokens. The profile's repositories and activation survive.
  * <proxies> keep host/port/nonProxyHosts; username/password are dropped.
  * settings-security.xml is never read, so a {...}-encrypted password cannot be
    decrypted. Such a server is reported and emitted without credentials rather
    than with a placeholder that would resolve to literal "${env...}".
"""

import argparse
import os
import re
import sys
import xml.etree.ElementTree as ET

NS = "http://maven.apache.org/SETTINGS/1.0.0"
HOST_REPO_ID = "seu-host-m2"


def local(tag):
    return tag.rsplit("}", 1)[-1]


def kids(el, name):
    return [c for c in el if local(c.tag) == name]


def child_text(el, name):
    for c in kids(el, name):
        return (c.text or "").strip()
    return None


def find_section(root, name):
    """Top-level <mirrors>/<servers>/... container, or None."""
    for c in root:
        if local(c.tag) == name:
            return c
    return None


def env_prefix(server_id):
    return "SEU_MVN_" + re.sub(r"[^A-Za-z0-9]", "_", server_id).upper()


def esc(text):
    return (
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    )


def serialize(el, indent, drop=()):
    """Render an element without namespace prefixes, dropping named children."""
    out = []
    tag = local(el.tag)
    if tag in drop:
        return out
    children = [c for c in el if local(c.tag) not in drop]
    text = (el.text or "").strip()
    pad = " " * indent
    if not children:
        out.append("%s<%s>%s</%s>" % (pad, tag, esc(text), tag) if text
                   else "%s<%s/>" % (pad, tag))
        return out
    out.append("%s<%s>" % (pad, tag))
    for c in children:
        out.extend(serialize(c, indent + 2, drop))
    out.append("%s</%s>" % (pad, tag))
    return out


def load(path):
    if not path or not os.path.isfile(path):
        return None
    try:
        return ET.parse(path).getroot()
    except Exception as exc:  # a broken settings.xml must not break `seu build`
        print("warn  could not parse %s: %s" % (path, exc), file=sys.stderr)
        return None


def collect_servers(root, wanted):
    """-> [(id, username, password)] for servers that have usable credentials."""
    found = []
    section = find_section(root, "servers") if root is not None else None
    for server in kids(section, "server") if section is not None else []:
        sid = child_text(server, "id")
        if not sid or (wanted and sid not in wanted):
            continue
        user, password = child_text(server, "username"), child_text(server, "password")
        if not user or not password:
            continue
        if password.startswith("${"):
            # An ${env.X} placeholder in the host file is not a credential.
            continue
        if password.startswith("{") and password.endswith("}"):
            print("warn  server '%s' uses an encrypted password; seu does not read "
                  "settings-security.xml, so it is skipped" % sid, file=sys.stderr)
            continue
        found.append((sid, user, password))
    return found


def fallback_servers(wanted, already):
    """GITHUB_ACTOR/GITHUB_TOKEN still work for servers settings.xml does not cover."""
    user, token = os.environ.get("GITHUB_ACTOR"), os.environ.get("GITHUB_TOKEN")
    if not token:
        return []
    have = {sid for sid, _, _ in already}
    return [(sid, user or "x-access-token", token) for sid in wanted if sid not in have]


def emit_env(root, wanted):
    servers = collect_servers(root, wanted)
    servers += fallback_servers(wanted, servers)
    for sid, user, password in servers:
        prefix = env_prefix(sid)
        print("%s_USER=%s" % (prefix, user))
        print("%s_PASS=%s" % (prefix, password))
    return 0 if servers or not wanted else 1


def host_repo_block(path):
    """A local repository is a valid file:// remote for RELEASES.

    Snapshots are deliberately disabled against it: a local repository holds
    maven-metadata-<repoid>.xml, not the remote layout that snapshot and version
    -range resolution need. This is an ADDITIONAL repository, not a mirror, so
    anything it cannot serve falls through to the real remotes.
    """
    policy = (
        "          <releases><enabled>true</enabled>"
        "<updatePolicy>never</updatePolicy>"
        "<checksumPolicy>ignore</checksumPolicy></releases>\n"
        "          <snapshots><enabled>false</enabled></snapshots>"
    )
    return """  <profiles>
    <profile>
      <id>%(id)s</id>
      <repositories>
        <repository>
          <id>%(id)s</id>
          <name>host Maven repository (read-only, build sandbox only)</name>
          <url>file://%(path)s</url>
%(policy)s
        </repository>
      </repositories>
      <pluginRepositories>
        <pluginRepository>
          <id>%(id)s</id>
          <url>file://%(path)s</url>
%(policy)s
        </pluginRepository>
      </pluginRepositories>
    </profile>""" % {"id": HOST_REPO_ID, "path": path, "policy": policy}


def emit_settings(root, wanted, host_repo):
    out = [
        '<settings xmlns="%s"' % NS,
        '          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
        '          xsi:schemaLocation="%s '
        'http://maven.apache.org/xsd/settings-1.0.0.xsd">' % NS,
        "  <!-- Generated by `seu build` from the host ~/.m2/settings.xml.",
        "       Credentials are ${env.*} placeholders on purpose: the real values",
        "       live only in the warm-up process's environment and this file is",
        "       replaced with an offline-only one before the session starts. -->",
    ]

    servers = collect_servers(root, wanted)
    servers += fallback_servers(wanted, servers)
    if servers:
        out.append("  <servers>")
        for sid, _, _ in servers:
            prefix = env_prefix(sid)
            out.append("    <server>")
            out.append("      <id>%s</id>" % esc(sid))
            out.append("      <username>${env.%s_USER}</username>" % prefix)
            out.append("      <password>${env.%s_PASS}</password>" % prefix)
            out.append("    </server>")
        out.append("  </servers>")

    if root is not None:
        groups = find_section(root, "pluginGroups")
        if groups is not None and len(groups):
            out.extend(serialize(groups, 2))

        mirrors = find_section(root, "mirrors")
        if mirrors is not None and len(mirrors):
            out.extend(serialize(mirrors, 2))

        proxies = find_section(root, "proxies")
        if proxies is not None and len(proxies):
            out.extend(serialize(proxies, 2, drop=("username", "password")))

    profiles = find_section(root, "profiles") if root is not None else None
    carried = [p for p in kids(profiles, "profile")] if profiles is not None else []

    if host_repo:
        out.append(host_repo_block(host_repo))
    elif carried:
        out.append("  <profiles>")

    for profile in carried:
        if kids(profile, "properties"):
            print("warn  profile '%s': <properties> dropped (secrets hide there); "
                  "its repositories are kept" % (child_text(profile, "id") or "?"),
                  file=sys.stderr)
        out.extend(serialize(profile, 4, drop=("properties",)))

    if host_repo or carried:
        out.append("  </profiles>")

    active = find_section(root, "activeProfiles") if root is not None else None
    lines = serialize(active, 2) if active is not None and len(active) else []
    if host_repo:
        if lines:
            lines.insert(1, "    <activeProfile>%s</activeProfile>" % HOST_REPO_ID)
        else:
            lines = ["  <activeProfiles>",
                     "    <activeProfile>%s</activeProfile>" % HOST_REPO_ID,
                     "  </activeProfiles>"]
    out.extend(lines)

    out.append("</settings>")
    print("\n".join(out))
    return 0


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--emit-settings", action="store_true")
    mode.add_argument("--emit-env", action="store_true")
    mode.add_argument("--list-servers", action="store_true",
                      help="print the server ids that have usable credentials")
    ap.add_argument("--source", default=os.path.expanduser("~/.m2/settings.xml"))
    ap.add_argument("--server", action="append", default=[],
                    help="restrict to this server id; repeatable")
    ap.add_argument("--host-repo", default=None,
                    help="guest path of the read-only host Maven repository")
    args = ap.parse_args(argv)

    root = load(args.source)
    wanted = set(args.server)

    if args.emit_env:
        return emit_env(root, wanted)
    if args.list_servers:
        for sid, _, _ in collect_servers(root, wanted) :
            print(sid)
        return 0
    return emit_settings(root, wanted, args.host_repo)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
