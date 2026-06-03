# tanka-wm — agent-driven setup guide

**Audience: an AI coding agent.** A user asked you to set up `tanka-wm` — the
work-memory session sync tool — for them. This is the complete, deterministic,
non-interactive procedure. You write the config files and run CLI commands
directly; you do **not** need the TUI for any of it.

`tanka-wm` discovers raw coding-agent session transcripts (Claude Code, Codex,
Cowork) on this machine and syncs them to the Tanka work-memory backend.
"Fully configured" means: a CLI on `PATH`, config + credentials written,
and a scheduled job running the upload.

Five steps, in order. Resolve any missing prerequisite before continuing.

---

## Step 1 — Install the CLI

**Option A — install script (recommended):**

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Shanda-Group-Ltd/tanka-work-memory-cli/dev/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/Shanda-Group-Ltd/tanka-work-memory-cli/dev/install.ps1 | iex
```

The script auto-detects the platform, downloads the binary from GitHub Releases,
verifies SHA-256 checksum, and installs to `~/.local/bin`. Pin a version with
`TANKA_WM_VERSION=v1.3.1`, or change the install dir with
`TANKA_WM_INSTALL_DIR=/usr/local/bin`.

**Option B — build from source:**

```bash
cd /path/to/tanka-work-memory-cli
bun install
bun run build          # → dist/tanka-wm-<platform> (self-contained; no node/bun to run)
# install the binary for this machine onto PATH (adjust the platform suffix):
install -m 755 dist/tanka-wm-darwin-arm64 /usr/local/bin/tanka-wm
```

```bash
tanka-wm --version     # verify
```

## Step 2 — Write the token + environment

Obtain the raw apiKey from `/open/auth/mcp/api-key/work-memory`, then write it
plus the target `env` (0600) under `~/.tanka-wm/` (or `$TANKA_WM_HOME`):

```bash
mkdir -p ~/.tanka-wm
umask 177
cat > ~/.tanka-wm/credentials.json <<'EOF'
{ "token": "mcp_sk_xxxxxxxxxxxxxxxxxxxx", "env": "prod" }
EOF
chmod 600 ~/.tanka-wm/credentials.json
```

Only environments compiled into the binary are available. The public release
includes `prod` only. Internal builds may include `dev`, `test`, `uat`.

## Step 3 — Pick a mode & write config

Write `config.json`. `deviceId` and `deviceName` are auto-generated on first
`sync` run if missing (via `ensureDeviceIdentity`), so they're optional here.
Set `wizardStep: "done"` to skip the TUI wizard.

### All mode — sync every session on the machine

Each cwd becomes its own project (1:1), lazily created on the backend at first
sync. No project list needed.

```bash
cat > ~/.tanka-wm/config.json <<'EOF'
{
  "version": 1,
  "mode": "all",
  "wizardStep": "done",
  "cwds": []
}
EOF
```

### Select mode — only configured projects

Each project needs a `remoteProjectId` (a backend-issued id — a ~12-char
nanoid; copy it verbatim from the API response, don't fabricate one) and an
`origin` (`created` or `joined`). The `cwds` array holds the working
directories; `projects` references them by `cwdIds`.

```bash
cat > ~/.tanka-wm/config.json <<'EOF'
{
  "version": 1,
  "mode": "select",
  "wizardStep": "done",
  "cwds": [
    { "id": "my-proj", "name": "My Project", "cwd": "/Users/me/code/my-project" },
    { "id": "my-lib", "name": "My Lib", "cwd": "/Users/me/code/my-lib" }
  ],
  "projects": [
    {
      "id": "my-proj",
      "remoteProjectId": "V1StGXR8Z5jd",
      "name": "My Project",
      "cwdIds": ["my-proj", "my-lib"],
      "origin": "created"
    }
  ]
}
EOF
```

To get a `remoteProjectId`, you can either:
- Use the TUI wizard (`tanka-wm` → step 3 → `c` create / `j` join)
- Call the API directly: `POST /link/workmemory/auth/project/save` with
  `{ "displayName": "...", "lookbackDays": 14, "reportLanguage": "en" }`
  → response contains `projectId` (the nanoid to use as `remoteProjectId`)

## Step 4 — Verify

```bash
tanka-wm --check   # smoke-test: render one TUI frame and exit 0 (verifies the binary runs)
tanka-wm sync      # uploads new/changed sessions; for all mode this also lazily creates remote projects
```

## Step 5 — Schedule the sync

```bash
tanka-wm cron install "0 */4 * * *"   # every 4 hours (default)
tanka-wm cron status                  # verify
tanka-wm cron remove                  # uninstall the job
```

The `tanka-wm cron` subcommand maps to the OS scheduler automatically: **cron**
on Linux, a per-user **LaunchAgent** on macOS, **Task Scheduler** on Windows.

**Supported cron expressions are a fixed subset**, not full cron grammar — the
expression must translate cleanly to launchd's interval / Task Scheduler's
trigger, so the day-of-month, month, and day-of-week fields **must all be `*`**.
Recognised shapes:

| Expression | Meaning |
|------------|---------|
| `*/N * * * *` | every N minutes (`*/1 * * * *` = every minute) |
| `M */N * * *` | every N hours (minute offset dropped) |
| `M * * * *`   | every hour at minute M |
| `M H * * *`   | daily at H:M |

A bare `* * * * *` is **rejected** (`unsupported minute field`) — use
`*/1 * * * *` for every-minute. Specific weekdays / months / days-of-month are
not supported.

---

## Updating

```bash
tanka-wm update          # check and install the latest version
tanka-wm update --check  # check only, don't install
```

The self-update downloads the matching binary from GitHub Releases, verifies
SHA-256 checksum, and atomically replaces the running executable.

## State files

| File | Description |
|------|-------------|
| `~/.tanka-wm/config.json` | mode, cwds, projects (each carries `env`), deviceId, deviceName, wizardStep |
| `~/.tanka-wm/credentials.json` | token + env (0600) |
| `~/.tanka-wm/uploads/<env>/<ns>.json` | upload manifest shards, namespaced by env then project |
| `~/.tanka-wm/project-map/<env>.json` | all-mode cwd→remoteProjectId mapping, one per env |
| `~/.tanka-wm/schedule.json` | installed cron expr echo |

## Notes

- **Incremental**: manifest tracks transcript mtime+size; only new/changed
  sessions re-upload. The upload is complete only after `/sync` API succeeds.
- **401 handling**: token can expire. On 401, re-fetch the apiKey and overwrite
  `credentials.json`.
- **deviceId/deviceName**: auto-generated on first `sync` if missing. Override
  by setting them in `config.json` before first run.
