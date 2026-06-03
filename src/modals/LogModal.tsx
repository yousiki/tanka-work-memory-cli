/** Log viewer modal — scrollable tail of ~/.work-memory/tui/wm.log. */
import { Box, Text } from 'ink';
import type React from 'react';
import { useState } from 'react';

import { HintBar, ScreenFrame } from '../components/ScreenFrame';
import { useScreenInput } from '../hooks/useScreenInput';
import { useTerminalSize } from '../hooks/useTerminalSize';
import { clearLog, logPath, readLogTail } from '../log';
import { clipLine } from '../text';
import { theme } from '../theme';

function lineColor(line: string): string | undefined {
  if (/\bERROR\b/.test(line)) return theme.err;
  if (/\bWARN\b/.test(line)) return theme.warn;
  return undefined;
}

export function LogModal({
  onClose,
}: {
  onClose: () => void;
}): React.ReactElement {
  const { rows, columns } = useTerminalSize();
  const height = Math.max(6, rows - 8);
  const [lines, setLines] = useState<string[]>(() => readLogTail(2000));
  const [scroll, setScroll] = useState(0);

  const maxScroll = Math.max(0, lines.length - height);

  useScreenInput((input, key) => {
    if (key.escape || input === 'q') onClose();
    else if (key.upArrow || input === 'k') setScroll((s) => Math.max(0, s - 1));
    else if (key.downArrow || input === 'j')
      setScroll((s) => Math.min(maxScroll, s + 1));
    else if (key.pageUp) setScroll((s) => Math.max(0, s - height));
    else if (key.pageDown) setScroll((s) => Math.min(maxScroll, s + height));
    else if (input === 'g') setScroll(0);
    else if (input === 'G') setScroll(maxScroll);
    else if (input === 'c') {
      clearLog();
      setLines([]);
      setScroll(0);
    }
  });

  const win = lines.slice(scroll, scroll + height);

  return (
    <ScreenFrame
      title="Activity log"
      subtitle={logPath()}
      footer={
        <HintBar
          hints={[
            ['↑↓/PgUp/PgDn', 'scroll'],
            ['c', 'clear'],
            ['esc', 'close'],
          ]}
        />
      }
    >
      <Box flexDirection="column">
        {lines.length === 0 ? (
          <Text color={theme.dim}>(log is empty)</Text>
        ) : (
          win.map((l, i) => (
            <Text
              key={scroll + i}
              color={lineColor(l)}
              dimColor={lineColor(l) === undefined}
            >
              {clipLine(l, Math.max(20, columns - 4))}
            </Text>
          ))
        )}
        {lines.length > height ? (
          <Text color={theme.dim}>
            {`  — ${scroll + 1}–${Math.min(lines.length, scroll + height)} / ${lines.length} —`}
          </Text>
        ) : null}
      </Box>
    </ScreenFrame>
  );
}
