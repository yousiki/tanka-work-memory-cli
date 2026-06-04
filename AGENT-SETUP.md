# tanka-wm — agent-driven setup guide

**Audience: an AI coding agent.** A user asked you to set up `tanka-wm` — the
work-memory session sync tool — for them. This is the complete, deterministic,
non-interactive procedure.

`tanka-wm` discovers raw coding-agent session transcripts (Claude Code, Codex,
Cowork) on this machine and syncs them to the Tanka work-memory backend.
"Fully configured" means: a CLI on `PATH`, config + credentials written,
and a scheduled job running the upload.

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
`TANKA_WM_VERSION=v1.3.7`, or change the install dir with
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

## Step 3 — Pick a mode

Ask the user which mode they prefer. **Recommend "all" mode** — it syncs every
coding-agent session on the machine automatically with zero configuration.

### If the user chooses "all" mode (recommended)

Write the config and proceed to Step 4:

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

### If the user chooses "select" mode

**Stop the agent-driven setup here.** Select mode requires interactive project
management (create/join projects, assign working directories) which is best
done through the TUI. Tell the user:

> Select mode requires interactive configuration. Please run `tanka-wm` to
> launch the TUI — the setup wizard will guide you through creating or joining
> projects and assigning working directories. Once the wizard completes, come
> back and we'll set up the scheduled sync (Step 5).

Write a minimal config so the TUI starts the wizard at the right step:

```bash
cat > ~/.tanka-wm/config.json <<'EOF'
{
  "version": 1,
  "mode": "select",
  "wizardStep": "tanka",
  "cwds": []
}
EOF
```

Then skip to Step 5 after the user confirms the TUI wizard is done.

## Step 4 — Verify (all mode only)

```bash
tanka-wm --check   # smoke-test: render one TUI frame and exit 0; also auto-generates deviceId + deviceName
tanka-wm sync      # uploads new/changed sessions; lazily creates remote projects for each discovered cwd
```

`--check` and `sync` both call `ensureDeviceIdentity`, which generates a stable
`deviceId` (UUID) and `deviceName` (hostname) on first run. No need to set
them manually. `deviceName` is editable later in the TUI via Tanka settings (`t`).

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

The CLI also auto-updates on every run (throttled to once every 4 hours). If an
update is found, the binary is replaced and the command re-executes seamlessly.
Disable with `TANKA_WM_NO_AUTO_UPDATE=1`.

## State files

| File | Description |
|------|-------------|
| `~/.tanka-wm/config.json` | mode, cwds, projects (each carries `env`), deviceId, deviceName, wizardStep |
| `~/.tanka-wm/credentials.json` | token + env (0600) |
| `~/.tanka-wm/uploads/<env>/<ns>.json` | upload manifest shards, namespaced by env then project |
| `~/.tanka-wm/project-map/<env>.json` | all-mode cwd→remoteProjectId mapping, one per env |
| `~/.tanka-wm/schedule.json` | installed cron expr echo |
| `~/.tanka-wm/update-state.json` | auto-update throttle state |

## Notes

- **Incremental**: manifest tracks transcript mtime+size; only new/changed
  sessions re-upload. The upload is complete only after `/sync` API succeeds.
- **401 handling**: token can expire. On 401, re-fetch the apiKey and overwrite
  `credentials.json`.
- **deviceId/deviceName**: auto-generated on first `--check` or `sync` run.
  `deviceName` is editable in the TUI via Tanka settings (`t`).
