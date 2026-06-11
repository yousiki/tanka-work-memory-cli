/** Keybinding reference modal — the run mode is shown in the subtitle. */
import { Box, Text } from 'ink';
import type React from 'react';

import { HintBar, ScreenFrame } from '../components/ScreenFrame';
import { useScreenInput } from '../hooks/useScreenInput';
import { theme } from '../theme';

const KEYS: Array<{
  key: string;
  desc: string;
  selectOnly?: boolean;
  allOnly?: boolean;
}> = [
  { key: 'tab', desc: 'switch panel — Projects ⇄ Sessions' },
  { key: '↑ ↓ / j k', desc: 'move within the focused panel' },
  { key: 'enter', desc: 'open transcript · or focus the sessions panel' },
  {
    key: 'r',
    desc: 'refresh — the whole list (on Projects) or just the sessions',
  },
  { key: 'u', desc: 'upload the selected session' },
  {
    key: 's',
    desc: 'sync the selected project — upload new / changed sessions',
  },
  { key: 'S', desc: 'sync all projects' },
  {
    key: 'm',
    desc: 'manage projects (create / join / edit / migrate / delete / leave)',
    selectOnly: true,
  },
  {
    key: 'm',
    desc: "migrate the selected directory's data into another project",
    allOnly: true,
  },
  { key: 't', desc: 'Tanka settings — environment, token & device name' },
  { key: 'w', desc: 're-run the setup wizard' },
  { key: 'c', desc: 'scheduled upload (cron / launchd / schtasks)' },
  { key: 'L', desc: 'activity log' },
  { key: '?', desc: 'this help' },
  { key: 'q', desc: 'quit' },
];

export function HelpModal({
  onClose,
  isAll,
}: {
  onClose: () => void;
  isAll: boolean;
}): React.ReactElement {
  useScreenInput(() => onClose());

  return (
    <ScreenFrame
      title="Keys"
      subtitle={isAll ? 'all-sessions mode' : 'select-projects mode'}
      footer={<HintBar hints={[['any key', 'close']]} />}
    >
      <Box flexDirection="column">
        {KEYS.filter(
          (k) => !(isAll && k.selectOnly) && !(!isAll && k.allOnly),
        ).map((k) => (
          <Box key={k.key}>
            <Text color={theme.accent}>{k.key.padEnd(13)}</Text>
            <Text color={theme.dim}>{k.desc}</Text>
          </Box>
        ))}
      </Box>
    </ScreenFrame>
  );
}
