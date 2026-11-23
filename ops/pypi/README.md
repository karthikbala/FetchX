# Publishing the Python SDK to PyPI

The SDK in `clients/python-sdk` is published as `fetchx-sdk` (imported as `fetchx`). It is released from porttrack with `release_python_sdk.py`, never from GitHub Actions. A version on PyPI can never be uploaded again, even after it is deleted, so an upload needs Karthik's typed go-ahead naming the version.

## Once, before the first release

1. Choose the SDK's license. Add `license = "<SPDX id>"` to `clients/python-sdk/pyproject.toml` and the license text as `clients/python-sdk/LICENSE`.
2. On pypi.org, sign in to the account that will own `fetchx-sdk`, turn on two-factor sign-in, and create an API token. The first upload needs a token for the whole account, because a token for one project can only be made once the project exists.
3. On porttrack, save the token where only root can read it:

   ```sh
   sudo install -d -m 0700 /opt/crawling-platform/secrets/pypi
   read -rsp 'PyPI token: ' T && printf '%s\n' "$T" | sudo install -m 0600 /dev/stdin /opt/crawling-platform/secrets/pypi/token; unset T
   ```

   The token is not shown while you paste it and does not go into the shell history.

4. After the first upload, make a token for `fetchx-sdk` only, put it in the same file, and delete the account-wide token on pypi.org.

## Each release

1. On a branch: set the version in `clients/python-sdk/src/fetchx/_version.py`, make the README's install line `pip install fetchx-sdk`, and note the release in `docs/changelog.json`. Merge it to main.
2. Tag the merge commit on main `python-sdk-v<version>`.
3. On porttrack, in a clean checkout of that tag:

   ```sh
   python3 -I ops/pypi/release_python_sdk.py check
   ```

   It builds the sdist and the wheel in a throwaway folder, runs `twine check`, installs the wheel in a fresh virtual environment, runs the SDK's offline tests and its `fetchx-connect` command there, asks PyPI whether the version is taken, and lists anything that stops an upload. It uploads nothing.
4. With the go-ahead:

   ```sh
   sudo python3 -I ops/pypi/release_python_sdk.py upload --version <version>
   ```

   It runs every check again, refuses while anything is listed, uploads both files with the token, and waits until PyPI shows the version.
