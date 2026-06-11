/** Scheduled-upload modal — install / remove the OS scheduler job (cron / launchd / schtasks) running `tanka-wm sync`. */
import { Box, Text } from 'ink';
import type React from 'react';
import { useMemo, useState } from 'react';

import { HintBar, ScreenFrame } from '../components/ScreenFrame';
import { TextInput } from '../components/TextInput';
import { applyTextKey } from '../components/textEditing';
import { useScreenInput } from '../hooks/useScreenInput';
import {
  installSchedule,
  removeSchedule,
  type SchedulerStatus,
  schedulerAvailable,
  schedulerKind,
  schedulerStatus,
} from '../scheduler';
import { theme } from '../theme';

const PRESETS: Array<{ label: string; expr: string }> = [
  { label: 'every 15 minutes', expr: '*/15 * * * *' },
  { label: 'every 30 minutes', expr: '*/30 * * * *' },
  { label: 'hourly', expr: '0 * * * *' },
  { label: 'every 2 hours', expr: '0 */2 * * *' },
  { label: 'every 4 hours', expr: '0 */4 * * *' },
  { label: 'every 6 hours', expr: '0 */6 * * *' },
  { label: 'daily at 09:00', expr: '0 9 * * *' },
];
const DEFAULT_PRESET = Math.max(
  0,
  PRESETS.findIndex((p) => p.expr === '0 */4 * * *'),
);

export function CronModal({
  onClose,
  onContinue,
  onBack,
  onCancelAll,
  wizardLabel,
}: {
  onClose: () => void;
  /** wizard mode: shows a "Continue →" row that advances the wizard */
  onContinue?: () => void;
  /** wizard mode: Esc goes back to the previous step instead of closing */
  onBack?: () => void;
  /** re-run mode: `c` (off the binary-path field) cancels the whole re-run */
  onCancelAll?: () => void;
  wizardLabel?: string;
}): React.ReactElement {
  const available = useMemo(() => schedulerAvailable(), []);
  const kind = useMemo(() => schedulerKind(), []);
  const [status, setStatus] = useState<SchedulerStatus>(() =>
    schedulerStatus(),
  );
  const [binPath, setBinPath] = useState(process.execPath);
  const [presetIdx, setPresetIdx] = useState(() => {
    const matched = PRESETS.findIndex((p) => p.expr === status.expr);
    // an already-installed schedule wins; otherwise default to every 4h in both
    // the wizard and the Board's cron modal (they share this component).
    return matched >= 0 ? matched : DEFAULT_PRESET;
  });
  // wizard mode lands on the action the user most likely wants next: Install
  // when nothing is scheduled yet, Continue when a schedule already exists
  // (e.g. re-running the wizard). The Board's modal keeps the binary field.
  const [focus, setFocus] = useState(() =>
    onContinue ? (status.installed ? 4 : 2) : 0,
  );
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'err' } | null>(
    null,
  );
  const ROWS = onContinue ? 5 : 4;

  const doInstall = (): void => {
    try {
      installSchedule(binPath.trim(), PRESETS[presetIdx]!.expr);
      setStatus(schedulerStatus());
      setMsg({ text: 'scheduled upload installed', tone: 'ok' });
    } catch (e: unknown) {
      setMsg({ text: e instanceof Error ? e.message : String(e), tone: 'err' });
    }
  };
  const doRemove = (): void => {
    try {
      removeSchedule();
      setStatus(schedulerStatus());
      setMsg({ text: 'schedule removed', tone: 'ok' });
    } catch (e: unknown) {
      setMsg({ text: e instanceof Error ? e.message : String(e), tone: 'err' });
    }
  };

  useScreenInput((input, key) => {
    if (key.escape) {
      (onBack ?? onClose)();
      return;
    }
    // `c` cancels the re-run — but not while editing the binary-path field (focus 0)
    if (input === 'C' && onCancelAll && focus !== 0) {
      onCancelAll();
      return;
    }
    if ((key.tab && key.shift) || key.upArrow) {
      setFocus((f) => (f + ROWS - 1) % ROWS);
      return;
    }
    if (key.tab || key.downArrow) {
      setFocus((f) => (f + 1) % ROWS);
      return;
    }
    if (focus === 0) {
      if (!key.return) setBinPath((s) => applyTextKey(s, input, key));
      return;
    }
    if (focus === 1) {
      if (key.leftArrow)
        setPresetIdx((i) => (i + PRESETS.length - 1) % PRESETS.length);
      else if (key.rightArrow || input === ' ')
        setPresetIdx((i) => (i + 1) % PRESETS.length);
      return;
    }
    if (focus === 2 && key.return) doInstall();
    if (focus === 3 && key.return) doRemove();
    if (focus === 4 && onContinue && key.return) onContinue();
  });

  const marker = (i: number): React.ReactElement => (
    <Text color={focus === i ? theme.brand : theme.dim}>
      {focus === i ? '❯ ' : '  '}
    </Text>
  );

  return (
    <ScreenFrame
      title="Scheduled upload"
      subtitle={wizardLabel ?? `system scheduler — ${kind}`}
      footer={
        <HintBar
          hints={[
            ['↑↓/tab', 'move'],
            ['←→', 'interval'],
            ['enter', 'activate'],
            ['esc', onBack ? 'back' : 'cancel'],
            ...(onCancelAll
              ? ([['C', 'cancel all']] as Array<[string, string]>)
              : []),
          ]}
        />
      }
    >
      <Box flexDirection="column">
        {!available ? (
          <Text color={theme.err}>
            {`system scheduler (${kind}) is not available on this machine.`}
          </Text>
        ) : (
          <>
            <Box>
              {marker(0)}
              <Text color={focus === 0 ? theme.text : theme.dim}>
                {'binary'.padEnd(12)}
              </Text>
              <TextInput
                value={binPath}
                focused={focus === 0}
                placeholder="/path/to/tanka-wm"
              />
            </Box>
            <Box>
              {marker(1)}
              <Text color={focus === 1 ? theme.text : theme.dim}>
                {'interval'.padEnd(12)}
              </Text>
              <Text>{'◀ '}</Text>
              <Text color={theme.accent}>{PRESETS[presetIdx]!.label}</Text>
              <Text>{' ▶'}</Text>
            </Box>
            <Box marginTop={1}>
              {marker(2)}
              <Text
                color={focus === 2 ? theme.text : theme.dim}
                bold={focus === 2}
              >
                {status.installed ? 'Update schedule' : 'Install schedule'}
              </Text>
            </Box>
            <Box>
              {marker(3)}
              <Text
                color={focus === 3 ? theme.err : theme.dim}
                bold={focus === 3}
              >
                Remove schedule
              </Text>
            </Box>
            {/* paddingLeft matches the 2-char `marker()` gutter on the rows above */}
            <Box flexDirection="column" marginTop={1} paddingLeft={2}>
              <Text bold color={status.installed ? theme.ok : theme.warn}>
                {status.installed
                  ? `● installed — ${status.expr ?? 'on'}`
                  : '○ not scheduled'}
              </Text>
              {!status.installed ? (
                <Text color={theme.warn}>
                  ⚠ without a schedule nothing uploads automatically — sessions
                  only sync when you run Sync manually
                </Text>
              ) : null}
            </Box>
            {onContinue ? (
              <Box marginTop={1}>
                {marker(4)}
                <Text
                  color={focus === 4 ? theme.brand : theme.dim}
                  bold={focus === 4}
                >
                  Continue →
                </Text>
              </Box>
            ) : null}
            <Box marginTop={1}>
              <Text color={theme.dim}>
                runs `tanka-wm sync` — incremental upload of new / changed
                sessions
              </Text>
            </Box>
            {msg ? (
              <Box marginTop={1}>
                <Text color={msg.tone === 'ok' ? theme.ok : theme.err}>
                  {`${msg.tone === 'ok' ? '✓' : '✗'} ${msg.text}`}
                </Text>
              </Box>
            ) : null}
          </>
        )}
      </Box>
    </ScreenFrame>
  );
}
