#!/usr/bin/env python3
"""Build, check and (only when asked) upload the Python SDK, fetchx-sdk, to PyPI.

Run on porttrack, from a clean checkout of a python-sdk-v<version> tag on main. Nothing is
released from GitHub Actions, and nothing goes to PyPI without the upload command:

    python3 -I ops/pypi/release_python_sdk.py check                      # build, test, twine check; uploads nothing
    sudo python3 -I ops/pypi/release_python_sdk.py upload --version 0.2.0   # the same, then upload

check builds the sdist and the wheel in a throwaway folder, runs twine check, installs the
wheel in a fresh virtual environment, runs the SDK's offline tests and its command line
there, and asks PyPI whether the version is already taken. It lists what would stop an
upload. upload refuses while anything is listed, then uploads both files and waits until
PyPI shows the version.

A PyPI version can never be uploaded again, even after it is deleted, so upload runs only on
a typed go-ahead from Karthik that names the version.

Token: /opt/crawling-platform/secrets/pypi/token (or FX_PYPI_TOKEN_FILE), root-only (0600).
The first upload needs a token scoped to the whole PyPI account, because a project-scoped
token can only be made once the project exists. After it, replace the file with a token
scoped to fetchx-sdk and delete the account-wide one on pypi.org.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SDK = ROOT / 'clients' / 'python-sdk'
NAME = 'fetchx-sdk'
TOKEN_FILE = os.environ.get('FX_PYPI_TOKEN_FILE', '/opt/crawling-platform/secrets/pypi/token')
PYPI_JSON = 'https://pypi.org/pypi/{name}/{version}/json'
TOOLS = ['build==1.6.1', 'twine==7.0.0']
INSTALL_LINE = 'pip install fetchx-sdk'


class ReleaseError(Exception):
    pass


def sdk_version(sdk=SDK):
    text = (sdk / 'src' / 'fetchx' / '_version.py').read_text()
    match = re.search(r'^__version__\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"\s*$', text, re.M)
    if not match:
        raise ReleaseError('src/fetchx/_version.py has no x.y.z __version__')
    return match.group(1)


def source_problems(sdk=SDK):
    """What in the package's own files stops a release."""
    problems = []
    pyproject = (sdk / 'pyproject.toml').read_text()
    if not re.search(r'^license\s*=', pyproject, re.M):
        problems.append('pyproject.toml has no license: choose one, add license = "..." and a LICENSE file')
    elif not any((sdk / name).exists() for name in ('LICENSE', 'LICENSE.txt', 'LICENSE.md')):
        problems.append('clients/python-sdk has no LICENSE file')
    if not re.search(r'^name\s*=\s*"' + re.escape(NAME) + '"', pyproject, re.M):
        problems.append(f'pyproject.toml does not name the distribution {NAME}')
    readme = (sdk / 'README.md').read_text()
    if INSTALL_LINE not in readme or 'git+https://' in readme:
        problems.append(f'README.md should install with "{INSTALL_LINE}" (PyPI shows it), not from GitHub')
    if re.search(r'\]\((?!https?://|#)[^)]*\)', readme):
        problems.append('README.md has relative links, which break on PyPI')
    return problems


def git(*args):
    return subprocess.run(['git', '-C', str(ROOT), *args], capture_output=True, text=True).stdout.strip()


def checkout_problems(version):
    """What about the checkout stops a release: it must be a clean tag on main."""
    problems = []
    if git('status', '--porcelain', '--untracked-files=no'):
        problems.append('the checkout has uncommitted changes')
    tag = f'python-sdk-v{version}'
    if tag not in git('tag', '--points-at', 'HEAD').split():
        problems.append(f'HEAD is not tagged {tag}')
    if not any(ref.strip() in ('origin/main', 'main') for ref in git('branch', '-a', '--contains', 'HEAD',
                                                                      '--format=%(refname:short)').splitlines()):
        problems.append('HEAD is not on main')
    return problems


def on_pypi(version):
    """True when PyPI already has this version (it can never be uploaded again)."""
    request = urllib.request.Request(PYPI_JSON.format(name=NAME, version=version),
                                     headers={'User-Agent': 'fetchx-release-check'})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status == 200
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return False
        raise ReleaseError(f'PyPI answered HTTP {error.code} for {NAME} {version}')


def run(command, **kwargs):
    print('$', ' '.join(str(part) for part in command), flush=True)
    subprocess.run([str(part) for part in command], check=True, **kwargs)


def venv(path):
    run([sys.executable, '-m', 'venv', path])
    python = Path(path) / ('Scripts' if os.name == 'nt' else 'bin') / 'python'
    run([python, '-m', 'pip', 'install', '--quiet', '--upgrade', 'pip'])
    return python


def build_and_test(work, version):
    """Build both files, check them, and test the wheel as a user would install it."""
    tools = venv(work / 'tools')
    run([tools, '-m', 'pip', 'install', '--quiet', *TOOLS])
    dist = work / 'dist'
    run([tools, '-m', 'build', '--outdir', dist, SDK])
    files = sorted(dist.iterdir())
    names = [file.name for file in files]
    wheel = f'{NAME.replace("-", "_")}-{version}-py3-none-any.whl'
    if sorted(names) != sorted([wheel, f'{NAME.replace("-", "_")}-{version}.tar.gz']):
        raise ReleaseError(f'unexpected build output: {names}')
    run([tools, '-m', 'twine', 'check', '--strict', *files])
    user = venv(work / 'user')
    run([user, '-m', 'pip', 'install', '--quiet', dist / wheel])
    run([user, '-I', '-c', 'import fetchx, fetchx.testing; assert fetchx.__version__ == %r, fetchx.__version__; '
                           'assert callable(fetchx.connect) and callable(fetchx.FetchX.prices)' % version])
    run([Path(user).parent / 'fetchx-connect', '--help'], stdout=subprocess.DEVNULL)
    run([user, '-m', 'fetchx', 'connect', '--help'], stdout=subprocess.DEVNULL)
    # The SDK's offline tests (no network, no credentials), with the wheel's dependencies.
    run([user, '-m', 'unittest', 'discover', '-s', 'test', '-p', 'python_sdk_*test.py'], cwd=ROOT,
        env={'PATH': os.environ.get('PATH', ''), 'HOME': str(work)})
    for file in files:
        print(f'{hashlib.sha256(file.read_bytes()).hexdigest()}  {file.name}')
    return tools, files


def read_token():
    path = Path(TOKEN_FILE)
    try:
        mode = path.stat().st_mode
    except FileNotFoundError:
        raise ReleaseError(f'no PyPI token at {path}: create one on pypi.org and save it there (root-only, 0600)')
    except PermissionError:
        raise ReleaseError(f'{path} is not readable by this user: run upload with sudo')
    if mode & 0o077:
        raise ReleaseError(f'{path} can be read by other users: chmod 600 {path}')
    token = path.read_text().strip()
    if not token.startswith('pypi-'):
        raise ReleaseError(f'{path} does not hold a PyPI API token (pypi-...)')
    return token


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('command', choices=('check', 'upload'))
    parser.add_argument('--version', help='the version being uploaded; must match _version.py (upload needs it)')
    args = parser.parse_args(argv)
    version = sdk_version()
    if args.version and args.version != version:
        raise ReleaseError(f'--version {args.version} does not match _version.py ({version})')
    if args.command == 'upload' and not args.version:
        raise ReleaseError('upload needs --version, naming the version you were told to publish')
    problems = source_problems() + checkout_problems(version)
    if on_pypi(version):
        problems.append(f'{NAME} {version} is already on PyPI; versions cannot be reused, so bump _version.py')
    with tempfile.TemporaryDirectory(prefix='fetchx-sdk-release-') as folder:
        tools, files = build_and_test(Path(folder), version)
        if problems:
            print('\nWhat stops an upload:', *(f'  - {problem}' for problem in problems), sep='\n')
        else:
            print(f'\n{NAME} {version} is ready to upload.')
        if args.command == 'check':
            return 0
        if problems:
            return 1
        token = read_token()
        env = {**os.environ, 'TWINE_USERNAME': '__token__', 'TWINE_PASSWORD': token,
               'TWINE_NON_INTERACTIVE': '1'}
        run([tools, '-m', 'twine', 'upload', '--disable-progress-bar', *files], env=env)
    for _ in range(30):
        if on_pypi(version):
            print(f'PyPI shows {NAME} {version}: https://pypi.org/project/{NAME}/{version}/')
            return 0
        time.sleep(10)
    print(f'Uploaded, but PyPI does not show {NAME} {version} yet; check https://pypi.org/project/{NAME}/')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ReleaseError, subprocess.CalledProcessError) as error:
        print(f'release_python_sdk: {error}', file=sys.stderr)
        sys.exit(1)
