#!/bin/sh
set -eu

role=${1:-}
case "$role" in
  staging|remote) ;;
  *) echo "Usage: sudo sh $0 staging|remote" >&2; exit 2 ;;
esac
if [ "$(id -u)" != 0 ] || [ "$(uname -s):$(uname -m)" != Linux:x86_64 ]; then
  echo 'Run as root on a Linux AMD64 worker host.' >&2
  exit 2
fi

root=/srv/fxpool
account=fetchx-tunnel
uid=10001
gid=10001
shell=/usr/sbin/nologin

group_name=$(getent group "$gid" | cut -d: -f1)
group_id=$(getent group "$account" | cut -d: -f3)
user_name=$(getent passwd "$uid" | cut -d: -f1)
user_spec=$(getent passwd "$account" | cut -d: -f3,4,6,7)
if { [ -n "$group_name" ] && [ "$group_name" != "$account" ]; } ||
   { [ -n "$group_id" ] && [ "$group_id" != "$gid" ]; } ||
   { [ -n "$user_name" ] && [ "$user_name" != "$account" ]; } ||
   { [ -n "$user_spec" ] && [ "$user_spec" != "$uid:$gid:$root/tunnel:$shell" ]; }; then
  echo 'FetchX tunnel account or numeric ID is in use. Inspect the existing identity before setup.' >&2
  exit 1
fi
if [ -z "$group_name" ]; then
  groupadd --system --gid "$gid" "$account"
fi
if [ -z "$user_name" ]; then
  useradd --system --no-create-home --uid "$uid" --gid "$gid" --home-dir "$root/tunnel" --shell "$shell" "$account"
fi

install -d -o root -g root -m 0755 "$root" "$root/browser" "$root/pin" "$root/run"
install -d -o "$uid" -g "$gid" -m 0700 "$root/tunnel" "$root/run/cb" "$root/run/worker"
if [ "$role" = staging ]; then
  install -d -o "$uid" -g "$gid" -m 0700 "$root/run/remote"
  install -d -o root -g root -m 0700 "$root/secrets"
  install -d -o root -g root -m 0755 "$root/registry"
fi
