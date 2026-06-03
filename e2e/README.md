# tanka-wm — Linux End-to-End Tests

Runs the full `tanka-wm` CLI lifecycle inside a clean Linux container
(Docker Desktop) against **real Tanka backends**. The only mocked part is
the **input side** — a fake Claude Code session transcript; the token and
env come from the **host machine's real credentials**, and the backend,
upload, and S3 are all real.

## Design Trade-offs (Why We Test This Way)

| Dimension | Trade-off | Reason |
|-----------|-----------|--------|
| token / env | Use the host machine's real `credentials.json` | Both of the CLI's HTTP egress paths use hardcoded `BASE_URLS` (`tanka-client.ts`), selecting the URL by env — they cannot be redirected to a local mock. Real credentials = real cloud traffic. |
| session | Mock (fake transcript) | Simply place a fake `~/.claude/projects/<encoded-cwd>/*.jsonl` and the discovery logic picks it up and uploads it. |
| target project | Create a dedicated `e2e-test-<timestamp>` project via API **before** sync | Fake data goes into an isolated project; real projects are not polluted. |
| post-test cleanup | **No cleanup** — data is kept for manual inspection | Makes it easy to log in to the test environment and confirm the fake session actually reached the cloud. |
| architecture | Apple Silicon auto-selects `linux-arm64` + `--platform linux/arm64` | Container runs natively, no qemu emulation. |

## End-to-End Chain Under Test

1. **Binary runs** — `--version` / `--help` / `--check` (Ink + yoga-wasm renders one frame in a non-TTY container).
2. **Create project** — `POST /link/workmemory/auth/project/save` creates a real project, obtains `remoteProjectId`; a probe checks whether it immediately appears in `/project/list` (the select+created sync pre-validation depends on this).
3. **First sync** — real two-step upload (apply for pre-signed URL → PUT to S3) → `POST /sync` registers the session → asserts `1 uploaded`, and the manifest shard `uploads/<remoteProjectId>.json` is written to disk containing this session.
4. **Idempotent re-sync** — second sync asserts `0 uploaded` + `1 up-to-date`.
5. **Cron lifecycle** — `cron install/status/remove` (Linux `crontab` backend), with direct `crontab -l` checks for marker block creation and removal.

Any assertion failure → container exits non-zero → host script reports `❌`.

## Usage

```bash
# Prerequisites: Docker Desktop is running; host has ~/.tanka-wm/credentials.json configured (token + env)
e2e/run-e2e.sh                # core e2e assertions (create project → sync → idempotent → cron file read/write)
e2e/run-e2e.sh --cron         # run the "real cron daemon fires on schedule" test instead (long-lived container, ~1-2 minutes)
e2e/run-e2e.sh --no-build     # skip binary compilation (reuse existing dist/); can be combined with --cron
```

The two suites cover different things:

| Suite | Entry point | Coverage |
|-------|-------------|----------|
| `e2e` (default) | `container-e2e.sh` | Binary smoke test + create project + sync + idempotent + `cron install/status/remove` writes correct crontab |
| `--cron` | `container-cron-live.sh` | Starts a real `cron` daemon, waits for it to fire `tanka-wm sync` at the next minute boundary, and proves the timer actually triggered via manifest + log evidence |

## Files

| File | Role |
|------|------|
| `run-e2e.sh` | Host orchestrator: detect arch → `bun build --compile` → `docker build` → `docker run` (bind-mount real credentials read-only). |
| `Dockerfile` | `debian:stable-slim` + `ca-certificates/curl/jq/cron/git`, `COPY` binary and container scripts. |
| `container-e2e.sh` | In-container main flow: create project → write config → generate mock session → sync → idempotent → cron, with assertions throughout. |

## Known Risk Points (Scripts Warn Explicitly, Never Swallow Silently)

- **Pre-validation contract**: If a newly created project does not immediately appear in `/project/list`, the select+created sync may judge it as not-found and skip it. Step 2 of the script probes for this and prints a warning.
- **Backend side effects**: Each run leaves behind one `e2e-test-*` project and one fake session, which must be cleaned up manually.
- **Cron daemon**: The default suite only tests `crontab` file read/write (install/status/remove); the `--cron` suite actually starts a real daemon to verify scheduled triggering. The latter must wait for the next minute boundary (~60s+), so it is a separate suite, not part of the default run.
