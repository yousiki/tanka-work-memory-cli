/** Terminal dimensions, kept current across resizes. */
import { useStdout } from 'ink';
import { useEffect, useState } from 'react';

export interface TerminalSize {
  rows: number;
  columns: number;
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const read = (): TerminalSize => ({
    rows: stdout?.rows && stdout.rows > 0 ? stdout.rows : 24,
    columns: stdout?.columns && stdout.columns > 0 ? stdout.columns : 80,
  });
  const [size, setSize] = useState<TerminalSize>(read);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `read` only closes over `stdout`, which is already a dependency; re-subscribing on stdout change is correct.
  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => setSize(read());
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return size;
}
