# The pr2video sandbox: one container per run, in which the pull request's
# code is checked out, built and served, and recorded. Native on amd64 and
# arm64 (runc cannot create namespaces under qemu, so no emulated images).
#
# What lives here, and why:
#   - Node 24 on Debian (glibc: most apps and Playwright expect it), with
#     corepack for pnpm and yarn.
#   - A Docker engine (Docker-in-Docker): a repository's services - Postgres,
#     Redis, its own docker compose file - run inside the sandbox, so its
#     recipes see localhost as they would anywhere, and nothing reaches the
#     host's Docker. Needs --privileged; the entrypoint starts dockerd.
#   - Playwright, its Chromium and rrweb in /opt/pr2video, for the recorder,
#     apart from anything a project installs.
#   - The tools an agent reaches for unprompted: git, ripgrep, psql, python,
#     jq, curl, lsof.
FROM node:24-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates curl gnupg git ripgrep python3 python-is-python3 jq lsof procps \
       iproute2 iptables postgresql-client xz-utils zstd unzip less socat tini \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
       > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
       docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
  && git config --system --add safe.directory '*' \
  && git config --system advice.detachedHead false

# The recorder's Chromium lives in its own folder, and PLAYWRIGHT_BROWSERS_PATH
# is NOT set for the image: a project's own `playwright install` goes to its
# default cache and can never garbage-collect the recorder's browser (it did:
# linkwarden's postinstall removed it). The recorder sets the path itself.
RUN PLAYWRIGHT_BROWSERS_PATH=/opt/pr2video/browsers npx -y playwright@1.63.0 install --with-deps chromium \
  && rm -rf /root/.npm /var/lib/apt/lists/*

# The recorder's runtime: Playwright (driving the Chromium above) and rrweb.
# The recorder script itself is copied in for each recording, so changing it
# never rebuilds this image.
RUN mkdir -p /opt/pr2video \
  && cd /opt/pr2video \
  && npm init -y > /dev/null \
  && npm install --no-audit --no-fund playwright@1.63.0 rrweb@2.1.6 \
  && rm -rf /root/.npm

COPY entrypoint.sh /usr/local/bin/pr2video-entrypoint
RUN chmod +x /usr/local/bin/pr2video-entrypoint

WORKDIR /work
ENTRYPOINT ["tini", "--", "/usr/local/bin/pr2video-entrypoint"]
CMD ["sleep", "infinity"]
