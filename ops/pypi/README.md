# Publishing the Python SDK to PyPI

The SDK in `clients/python-sdk` is published as `fetchx-sdk` (imported as `fetchx`). It is released from porttrack with `release_python_sdk.py`, never from GitHub Actions. A version on PyPI can never be uploaded again, even after it is deleted, so an upload needs Karthik's typed go-ahead naming the version.

## Once, before the first release

1. The SDK is MIT-licensed (Karthik, 2026-11-23): `license = "MIT"` in `clients/python-sdk/pyproject.toml` and the text in `clients/python-sdk/LICENSE`.
2. On pypi.org, sign in to the account that will own `fetchx-sdk`, turn on two-factor sign-in, and create an API token. The first upload needs a token for the whole account, because a token for one project can only be made once the project exists.
3. Karthik saves the token on porttrack himself, over `ssh porttrack-production`, because Claude's sessions there may not write secrets. Only root can read it:

   ```sh
   sudo install -d -m 0700 /opt/crawling-platform/secrets/pypi
   read -rsp 'PyPI token: ' T && printf '%s\n' "$T" | sudo install -m 0600 /dev/stdin /opt/crawling-platform/secrets/pypi/token; unset T
   ```

   The token is not shown while you paste it and does not go into the shell history.

4. After the first upload, make a token for `fetchx-sdk` only, put it in the same file, and delete the account-wide token on pypi.org. Done on 2026-11-25: the file now holds the token "porttrack fetchx-sdk releases". To replace it later from the Mac in one line, use this. Piping the token straight into `sudo` under `ssh -t` printed success but wrote nothing, so this writes a private temporary file first and prints the file's new time:

   ```sh
   ssh -t porttrack-production 'read -rsp "PyPI token: " T; echo; case "$T" in pypi-*) ;; *) echo "not a pypi- token, nothing written"; exit 1;; esac; umask 077; F=$(mktemp) && printf "%s\n" "$T" > "$F" && unset T && sudo install -m 0600 -o root -g root "$F" /opt/crawling-platform/secrets/pypi/token; rm -f "$F"; sudo stat -c "file written %y, %s bytes" /opt/crawling-platform/secrets/pypi/token'
   ```

## Each release

1. On a branch: set the version in `clients/python-sdk/src/fetchx/_version.py`, make the README's install line `pip install fetchx-sdk`, and note the release in `docs/changelog.json`. Merge it to main.
2. Check the merge commit on porttrack, in a clean checkout of it:

   ```sh
   python3 -I ops/pypi/release_python_sdk.py check
   ```

   It builds the sdist and the wheel in a throwaway folder, runs `twine check`, installs the wheel in a fresh virtual environment, runs the SDK's offline tests and its `fetchx-connect` command there, asks PyPI whether the version is taken, and lists anything that stops an upload. It uploads nothing. Before the tag exists it lists only the missing tag.
3. With the go-ahead, Karthik tags and uploads from his Mac. Claude's sessions on porttrack may not push tags with root's GitHub key or read the PyPI token, so this step is his. Put the merge commit's full SHA and the version in:

   ```sh
   ssh -t porttrack-production 'D=$(mktemp -d) && sudo git clone -q git@github-fetchx:karthikbala/FetchX.git "$D/FetchX" && cd "$D/FetchX" && sudo git checkout -q --detach <merge-sha> && sudo git tag python-sdk-v<version> && sudo git push -q origin python-sdk-v<version> && sudo python3 -I ops/pypi/release_python_sdk.py upload --version <version>'
   ```

   It clones main as root, tags the merge commit, pushes the tag, runs every check again, refuses while anything is listed, uploads both files with the token, and waits until PyPI shows the version. 0.2.0 went out this way on 2026-11-25.
4. Install the version from PyPI in a clean virtual environment and check `fetchx.__version__`.
