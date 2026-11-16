#!/usr/bin/python3
"""Root SSH supervisor. Restore UID 10001/mode 0600 after every socket rebind."""
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time

REMOTE_WORKER = "/opt/fetchx-worker/run/worker/worker.sock"
REMOTE_CALLBACK = "/opt/fetchx-worker/run/cb/gw.sock"


def remove_socket(path):
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(mode):
        raise ValueError("forward path must be a socket")
    path.unlink()


def fix_socket(path):
    info = path.lstat()
    if not stat.S_ISSOCK(info.st_mode):
        raise ValueError("forward path must be a socket")
    os.chown(path, 10001, 10001, follow_symlinks=False)
    os.chmod(path, 0o600, follow_symlinks=False)


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2:
        raise ValueError("root supervisor requires a private configuration")
    config_path = Path(sys.argv[1])
    info = config_path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise ValueError("insecure tunnel configuration")
    config = json.loads(config_path.read_text())
    sock = Path(config["socket"])
    argv = config["argv"]
    argv = argv[:-1] + ["-NT", "-o", "ExitOnForwardFailure=yes", "-o", "StreamLocalBindMask=0177",
                       "-o", "StreamLocalBindUnlink=yes", "-L", str(sock) + ":" + REMOTE_WORKER,
                       "-R", REMOTE_CALLBACK + ":" + config["callback"]] + argv[-1:]
    child = None
    stopping = False

    def stop(_sig, _frame):
        nonlocal stopping
        stopping = True
        if child is not None:
            child.terminate()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while not stopping and time.time() < config["hard_deadline"]:
            remove_socket(sock)
            child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            while not stopping and child.poll() is None and time.time() < config["hard_deadline"]:
                try:
                    fix_socket(sock)
                except FileNotFoundError:
                    pass
                time.sleep(.1)
            if child.poll() is None:
                child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
            child = None
            if not stopping:
                time.sleep(1)
    finally:
        if child is not None and child.poll() is None:
            child.kill()
            child.wait()
        remove_socket(sock)


if __name__ == "__main__":
    main()
