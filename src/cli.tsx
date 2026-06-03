/**
 * tanka-work-memory-cli — entry point.
 *
 *   tanka-wm              launch the Ink board
 *   tanka-wm sync [proj]  headless incremental upload (cron target), then exit
 *   tanka-wm --version    print version
 *   tanka-wm --check      render one frame and exit 0 (binary smoke-test)
 */
import { EventEmitter } from 'node:events';
import { render } from 'ink';

import { App } from './app';
import {
  DEFAULT_TANKA_ENV,
  loadConfig,
  loadCredentials,
  projectsForEnv,
} from './config/config';
import { installSchedule, removeSchedule, schedulerStatus } from './scheduler';
import { runSync } from './sync';
import { WM_TUI_VERSION } from './version';

const argv = process.argv.slice(2);
const cmd = argv[0];

if (cmd === '--version' || cmd === '-v') {
  console.log(`tanka-wm ${WM_TUI_VERSION}`);
  process.exit(0);
}

if (cmd === '--help' || cmd === '-h') {
  console.log(
    [
      `tanka-wm ${WM_TUI_VERSION} — work-memory session manager`,
      '',
      'Usage:',
      '  tanka-wm                     launch the TUI board',
      '  tanka-wm sync [project]      upload new / changed sessions and exit (cron target)',
      '  tanka-wm cron install [expr] install the scheduled-upload job (default: 0 */4 * * *)',
      '  tanka-wm cron status         show the scheduled-upload job',
      '  tanka-wm cron remove         remove the scheduled-upload job',
      '  tanka-wm update              check for updates and install the latest version',
      '  tanka-wm update --check      check for updates without installing',
      '  tanka-wm --version           print version',
      '  tanka-wm --help              show this help',
    ].join('\n'),
  );
  process.exit(0);
}

if (cmd === 'cron') {
  const sub = argv[1];
  try {
    if (sub === 'status') {
      const st = schedulerStatus();
      console.log(
        st.installed ? `installed: ${st.expr ?? 'on'}` : 'not installed',
      );
      process.exit(0);
    }
    if (sub === 'remove') {
      removeSchedule();
      console.log('scheduled upload removed');
      process.exit(0);
    }
    if (sub === 'install') {
      const expr = argv[2] || '0 */4 * * *';
      installSchedule(process.execPath, expr);
      console.log(
        `scheduled upload installed: ${expr}  →  ${process.execPath} sync`,
      );
      process.exit(0);
    }
    console.error('usage: wm cron <status|install [cron-expr]|remove>');
    process.exit(1);
  } catch (e: unknown) {
    console.error(`cron: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

if (cmd === 'update') {
  const { checkForUpdate, performUpdate, isCompiledBinary, formatBytes } =
    await import('./update');

  const checkOnly = argv.includes('--check');

  try {
    process.stdout.write('checking for updates… ');
    const result = await checkForUpdate();

    if (!result.hasUpdate) {
      console.log(`already up to date (${result.current})`);
      process.exit(0);
    }

    console.log(`update available: ${result.current} → ${result.latest}`);

    if (checkOnly) {
      if (result.release.htmlUrl) console.log(`  ${result.release.htmlUrl}`);
      process.exit(0);
    }

    if (!isCompiledBinary()) {
      console.error(
        'self-update is only supported for compiled binaries.\n' +
          'running from source — please pull the latest code instead.',
      );
      process.exit(1);
    }

    if (!result.matchedAsset) {
      console.error(
        `no binary available for ${process.platform}-${process.arch}`,
      );
      process.exit(1);
    }

    process.stdout.write(
      `downloading ${result.matchedAsset.name} (${formatBytes(result.matchedAsset.size)})… `,
    );

    const binPath = await performUpdate(result, (p) => {
      if (p.bytesTotal) {
        const pct = Math.round((p.bytesDownloaded / p.bytesTotal) * 100);
        process.stdout.write(`\rdownloading… ${pct}%  `);
      }
    });

    console.log(`\nupdated to ${result.latest} → ${binPath}`);
    process.exit(0);
  } catch (e: unknown) {
    console.error(
      `\nupdate failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }
}

if (cmd === 'sync') {
  try {
    // `sync [proj]` accepts a local project id or a remoteProjectId; resolve to
    // the remoteProjectId that runSync's select-mode limiter expects.
    let remoteProjectId = argv[1];
    if (remoteProjectId) {
      const cfg = loadConfig();
      const env = loadCredentials()?.env ?? DEFAULT_TANKA_ENV;
      const match = projectsForEnv(cfg, env).find(
        (p) =>
          p.id === remoteProjectId || p.remoteProjectId === remoteProjectId,
      );
      if (match) remoteProjectId = match.remoteProjectId;
    }
    const result = await runSync(remoteProjectId ? { remoteProjectId } : {});
    console.log(
      `sync: ${result.uploaded} uploaded, ${result.failed} failed, ${result.skipped} up-to-date, ${result.cleaned} cleaned`,
    );
    for (const err of result.errors.slice(0, 10)) console.error(`  ${err}`);
    process.exit(result.failed > 0 ? 1 : 0);
  } catch (e: unknown) {
    console.error(`sync failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

const checkMode = argv.includes('--check');

/**
 * Ink 7 throws if handed the real `process.stdin` when it's not a TTY — exactly
 * the --check / CI case. An inert stub sidesteps that while still rendering.
 */
function inertStdin(): NodeJS.ReadStream {
  const s = new EventEmitter() as unknown as NodeJS.ReadStream;
  Object.assign(s, {
    isTTY: false,
    setRawMode: () => s,
    ref: () => s,
    unref: () => s,
    read: () => null,
    setEncoding: () => s,
    resume: () => s,
    pause: () => s,
  });
  return s;
}

const { waitUntilExit } = render(<App checkMode={checkMode} />, {
  stdin: checkMode ? inertStdin() : process.stdin,
});
await waitUntilExit();
