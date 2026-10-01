"""Print the GitHub Packages username and token from a Maven settings.xml.

Two lines on stdout (username, then password) when a usable server entry is
found, nothing otherwise. Used by seu/lib/common.sh so `seu build` works with the
credentials the developer already configured per the project README, instead of
demanding GITHUB_ACTOR/GITHUB_TOKEN in the environment.
"""

import sys
import xml.etree.ElementTree as ET

WANTED = ("devx-repository", "ui-test-components-repository", "tsv-neubiberg-repository")


def main(path):
    try:
        root = ET.parse(path).getroot()
    except Exception:
        return 1

    for server in (e for e in root.iter() if e.tag.endswith("server")):
        fields = {c.tag.rsplit("}", 1)[-1]: (c.text or "").strip() for c in server}
        if fields.get("id") not in WANTED:
            continue
        user, password = fields.get("username"), fields.get("password")
        # `${env.GITHUB_TOKEN}`-style placeholders are not credentials.
        if user and password and not password.startswith("${"):
            print(user)
            print(password)
            return 0
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
