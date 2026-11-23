"""``python -m fetchx connect [--client-name NAME] [--credits-per-day N] [--credits-per-month N] [--expires-in-days N]``:
get a FetchX API key with Connect and save it where ``FetchX()`` finds it."""
import sys

from ._connect import main

if __name__ == "__main__":
    if sys.argv[1:2] != ["connect"]:
        sys.stderr.write("usage: python -m fetchx connect [--help]\n")
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[2:]))
