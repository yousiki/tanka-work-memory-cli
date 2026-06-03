/** Run-mode picker — the wizard's first step. All sessions vs. selected projects. */
import { Box, Text } from 'ink';
import type React from 'react';
import { useState } from 'react';

import { HintBar, ScreenFrame } from '../components/ScreenFrame';
import type { RunMode } from '../config/config';
import { useScreenInput } from '../hooks/useScreenInput';
import { theme } from '../theme';

const OPTIONS: Array<{ mode: RunMode; title: string; desc: string }> = [
  {
    mode: 'all',
    title: 'All sessions',
    desc: 'Sync every coding-agent session on this machine. New directories are picked up automatically — no project list to maintain.',
  },
  {
    mode: 'select',
    title: 'Select projects',
    desc: 'Pick specific projects (repos or directories). Only their sessions sync.',
  },
];

export function ModeScreen({
  current,
  onPick,
  onCancel,
  wizardLabel,
}: {
  current?: RunMode;
  onPick: (mode: RunMode) => void;
  onCancel: () => void;
  wizardLabel?: string;
}): React.ReactElement {
  const [sel, setSel] = useState(current === 'select' ? 1 : 0);

  useScreenInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow || input === 'k') setSel(0);
    else if (key.downArrow || input === 'j') setSel(1);
    else if (key.return) onPick(OPTIONS[sel]!.mode);
  });

  return (
    <ScreenFrame
      title="Run mode"
      subtitle={wizardLabel ?? 'how should tanka-wm decide what to sync?'}
      footer={
        <HintBar
          hints={[
            ['↑↓', 'move'],
            ['enter', 'choose'],
            ['esc', 'cancel'],
          ]}
        />
      }
    >
      <Box flexDirection="column">
        {OPTIONS.map((o, i) => {
          const active = i === sel;
          return (
            <Box key={o.mode} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={active ? theme.brand : theme.dim}>
                  {active ? '❯ ' : '  '}
                </Text>
                <Text color={active ? theme.text : undefined} bold={active}>
                  {o.title}
                </Text>
                {current === o.mode ? (
                  <Text color={theme.dim}>{'   (current)'}</Text>
                ) : null}
              </Box>
              <Text color={theme.dim}>{`    ${o.desc}`}</Text>
            </Box>
          );
        })}
      </Box>
    </ScreenFrame>
  );
}
