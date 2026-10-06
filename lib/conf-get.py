#!/usr/bin/env python3
"""Read one dotted path out of .seu/config.json, for the bash half of seu.

    conf-get.py <file> <dotted.path> [default]

Prints the string at that path, or the default when it is absent or not a
string. The authority on the schema is src/config/config.ts; this only has to
read it. Exits non-zero when the file is not valid JSON.
"""
import json
import sys


def main(argv):
    file, path = argv[1], argv[2]
    default = argv[3] if len(argv) > 3 else ""
    try:
        with open(file, encoding="utf-8") as fh:
            node = json.load(fh)
    except (OSError, ValueError) as err:
        print(f"{file}: {err}", file=sys.stderr)
        return 1

    for key in path.split("."):
        if not isinstance(node, dict) or key not in node:
            print(default)
            return 0
        node = node[key]
    print(node if isinstance(node, str) else default)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
