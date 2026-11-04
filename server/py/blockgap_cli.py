"""CLI bridge used by server.js: prints blockgap.blockgap_json(q) as JSON on stdout.

Drop Guru's blockgap.py next to this file (and its deps in requirements.txt).
"""
import json
import sys

import blockgap


def main() -> None:
    q = sys.argv[1] if len(sys.argv) > 1 else ""
    out = blockgap.blockgap_json(q)
    if isinstance(out, (str, bytes)):
        out = json.loads(out)
    sys.stdout.write(json.dumps(out, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
