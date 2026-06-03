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

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/Shanda-Group-Ltd/tanka-work-memory-cli/dev/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/Shanda-Group-Ltd/tanka-work-memory-cli/dev/install.ps1 | iex
```

The script auto-detects the platform, downloads the binary from GitHub Releases,
verifies SHA-256 checksum, and installs to `~/.local/bin`. Pin a version with
`TANKA_WM_VERSION=v1.3.1`, or change the install dir with
`TANKA_WM_INSTALL_DIR=/usr/local/bin`.

After installation, verify the binary works:

```bash
tanka-wm --version
```

If the command is not found, ensure `~/.local/bin` is in your `PATH` (the
installer will have prompted or auto-added it — you may need to restart your
shell).

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

First, initialize the device identity. `deviceId` is a stable UUID for this
installation; `deviceName` is a human-readable label (defaults to the machine's
hostname, editable later in the TUI). Both are written to `config.json`:

```bash
cat > ~/.tanka-wm/config.json <<EOF
{
  "version": 1,
  "mode": "all",
  "wizardStep": "done",
  "cwds": [],
  "deviceId": "$(uuidgen | tr '[:upper:]' '[:lower:]')",
  "deviceName": "$(hostname)"
}
EOF
```

### All mode — sync every session on the machine

If the user wants **all mode**, the config above is complete. Each cwd becomes
its own project (1:1), lazily created on the backend at first sync. No further
setup needed — skip to Step 4.

### Select mode — only configured projects

If the user wants **select mode**, set `mode` to `"select"` and `wizardStep`
to `"projects"` so the TUI opens directly to the project management screen:

```bash
cat > ~/.tanka-wm/config.json <<EOF
{
  "version": 1,
  "mode": "select",
  "wizardStep": "projects",
  "cwds": [],
  "deviceId": "$(uuidgen | tr '[:upper:]' '[:lower:]')",
  "deviceName": "$(hostname)"
}
EOF
```

Then tell the user to launch the TUI to configure their projects interactively:

```bash
tanka-wm
```

The TUI wizard will guide them through creating or joining projects and
assigning working directories. Once they finish and save, `wizardStep` advances
to `"done"` automatically.

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
- **deviceId/deviceName**: set in Step 3. If missing, auto-generated on first
  `sync`. `deviceName` is editable in the TUI via Tanka settings (`t`).
