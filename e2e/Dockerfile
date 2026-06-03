# Linux e2e test image — self-contained tanka-wm binary + minimal dependencies
# needed to run the full CLI assertion suite.
#
# Dependency notes (each is actually used by the tested commands, not filler):
#   - ca-certificates : sync needs HTTPS to the test backend + PUT to AWS S3 pre-signed URLs
#   - curl, jq        : used inside the container to create a dedicated test project via the real API and parse the returned projectId
#   - cron            : `tanka-wm cron` subcommand on Linux uses `crontab -l/-`, which requires this binary
#   - git             : discovery calls `git worktree list` (silently degrades in non-git dirs, but installed to exercise the real path)
FROM debian:stable-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates curl jq cron git \
  && rm -rf /var/lib/apt/lists/*

# run-e2e.sh copies the host-architecture binary to a fixed name: dist/tanka-wm-linux
COPY dist/tanka-wm-linux /usr/local/bin/tanka-wm
COPY e2e/container-e2e.sh /usr/local/bin/container-e2e.sh
COPY e2e/container-cron-live.sh /usr/local/bin/container-cron-live.sh
COPY install.sh /usr/local/bin/install.sh
RUN chmod 755 /usr/local/bin/tanka-wm \
      /usr/local/bin/container-e2e.sh \
      /usr/local/bin/container-cron-live.sh \
      /usr/local/bin/install.sh

# Real token is NOT baked into the image — it is bind-mounted read-only at
# /seed/credentials.json at runtime; the script copies it and tightens permissions.
ENTRYPOINT ["/usr/local/bin/container-e2e.sh"]
