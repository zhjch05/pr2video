#!/bin/bash
# Starts the sandbox's own Docker engine, then runs the container's command.
# A sandbox for an app with no services has no engine (PR2VIDEO_ENGINE=off):
# it is an ordinary container, not a privileged one, and dockerd could not run.
set -u

mkdir -p /var/log/pr2video /run/pr2video
if [ "${PR2VIDEO_ENGINE:-on}" = "off" ]; then
  exec "$@"
fi

# cgroup v2 nesting, as moby's hack/dind does it: move every process out of
# the root cgroup so its controllers can be delegated to dockerd's children.
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  mkdir -p /sys/fs/cgroup/init
  xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || :
  sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers \
    > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || :
fi

args=(--host=unix:///var/run/docker.sock)
if [ -n "${PR2VIDEO_REGISTRY_MIRROR:-}" ]; then
  args+=(--registry-mirror="$PR2VIDEO_REGISTRY_MIRROR" --insecure-registry="${PR2VIDEO_REGISTRY_MIRROR#http://}")
fi
dockerd "${args[@]}" > /var/log/pr2video/dockerd.log 2>&1 &

exec "$@"
