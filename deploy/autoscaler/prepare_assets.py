#!/usr/bin/python3
"""Prepare a private, pinned asset bundle from existing local production assets.

Does not download, run browsers, contact a provider, provision, or enable scaling.
The temporary Docker tag is deliberately retained for repeatable operator review.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile

from worker_agent import canonical, sha, validate_manifest, write


def run(argv):
    return subprocess.run(argv, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=900)


def prepare(image, browser_home, runtime_pin, seccomp, output):
    if os.geteuid() != 0:
        raise ValueError("run as root; bundle contains private production assets")
    if not re.fullmatch(r"(?:sha256:[a-f0-9]{64}|[A-Za-z0-9./:_-]+@sha256:[a-f0-9]{64})", image):
        raise ValueError("select the reviewed immutable image ID or repository digest")
    browser_home, runtime_pin, seccomp, output = map(Path, (browser_home, runtime_pin, seccomp, output))
    if not all(path.is_absolute() for path in (browser_home, runtime_pin, seccomp, output)):
        raise ValueError("all operator asset paths must be absolute")
    if output.exists():
        raise ValueError("use a fresh root-only output directory; never overwrite an existing bundle")
    pin = json.loads(runtime_pin.read_text())
    executable = pin.get("executablePath", "")
    if not executable.startswith("/opt/gateway-browser/") or ".." in Path(executable).parts:
        raise ValueError("unexpected qualified browser executable")
    binary = browser_home / executable.removeprefix("/opt/gateway-browser/")
    if sha(binary) != pin.get("sha256"):
        raise ValueError("existing browser differs from runtime pin")
    details = json.loads(run(["docker", "image", "inspect", image]).stdout)[0]
    if details.get("Os") != "linux" or details.get("Architecture") != "amd64" or not re.fullmatch(r"sha256:[a-f0-9]{64}", details.get("Id", "")):
        raise ValueError("reviewed image must be Linux AMD64")
    ref = "fetchx-autoscaler-pinned:" + details["Id"].removeprefix("sha256:")
    output.mkdir(mode=0o700, parents=False)
    run(["docker", "image", "tag", image, ref])
    image_path = output / "image.tar"
    run(["docker", "image", "save", "-o", str(image_path), ref])
    os.chmod(image_path, 0o600)
    browser_path = output / "browser.tar"
    # Sorted names and normalized archive metadata give a deterministic browser bundle.
    def normalize(info):
        if not (info.isfile() or info.isdir() or info.issym()):
            raise ValueError("unsupported browser bundle entry")
        if info.issym() and (Path(info.linkname).is_absolute() or ".." in Path(info.linkname).parts):
            raise ValueError("browser symlink escapes asset root")
        info.uid = info.gid = 0
        info.uname = info.gname = "root"
        info.mtime = 0
        info.mode = (info.mode & 0o555) | (0o755 if info.isdir() else 0o444)
        return info
    with tarfile.open(browser_path, "w", format=tarfile.PAX_FORMAT, dereference=False) as archive:
        for path in sorted(browser_home.rglob("*")):
            archive.add(path, arcname=path.relative_to(browser_home).as_posix(), recursive=False, filter=normalize)
    os.chmod(browser_path, 0o600)
    seccomp_path = output / "seccomp.json"
    write(seccomp_path, seccomp.read_bytes())
    manifest = {
        "version": 1,
        "image": {"archive": str(image_path), "sha256": sha(image_path), "ref": ref, "rootfs_layers": details["RootFS"]["Layers"]},
        "browser": {"archive": str(browser_path), "sha256": sha(browser_path), "executable": executable},
        "runtime_pin": pin,
        "seccomp": {"path": str(seccomp_path), "sha256": sha(seccomp_path)},
    }
    validate_manifest(manifest)
    write(output / "manifest.json", canonical(manifest))
    return output / "manifest.json"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--browser-home", default="/opt/crawling-platform/browser")
    parser.add_argument("--runtime-pin", default="/opt/crawling-platform/browser-pool/pin/runtime.json")
    parser.add_argument("--seccomp", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    print(prepare(args.image, args.browser_home, args.runtime_pin, args.seccomp, args.output))


if __name__ == "__main__":
    main()
