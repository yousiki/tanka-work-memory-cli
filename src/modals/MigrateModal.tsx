/**
 * Migrate modal — the single UI for pointing a project's (or directory's)
 * work-memory data at another project. Shared by both entry points:
 *
 *  - select mode (ProjectsScreen `m`): source is a configured project —
 *    runMigrate moves its data by project id.
 *  - all mode (Board `m`): source is a directory — runMigrateForCwd branches:
 *    a mapped dir migrates its project's data; a never-synced dir has nothing
 *    to move, so it joins the target and binds the cwd in the project-map.
 */
import { Box, Text } from 'ink';
import type React from 'react';
import { useState } from 'react';
import { HintBar, ScreenFrame } from '../components/ScreenFrame';
import { Spinner } from '../components/Spinner';
import { TextInput } from '../components/TextInput';
import { applyTextKey } from '../components/textEditing';
import { useConfig } from '../hooks/useConfig';
import { useScreenInput } from '../hooks/useScreenInput';
import { runMigrate, runMigrateForCwd } from '../migrate';
import { theme } from '../theme';

export type MigrateSource =
  | { kind: 'project'; name: string; remoteProjectId: string }
  | {
      kind: 'cwd';
      name: string;
      cwd: string;
      /** absent when the directory has never been synced (no remote project yet) */
      remoteProjectId?: string;
    };

export function MigrateModal({
  source,
  onDone,
  onClose,
}: {
  source: MigrateSource;
  onDone: (toast: { title: string; lines: string[]; ok: boolean }) => void;
  onClose: () => void;
}): React.ReactElement {
  const { config, credentials, setConfig } = useConfig();
  const [targetId, setTargetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const neverSynced = source.kind === 'cwd' && !source.remoteProjectId;

  const doSubmit = async (): Promise<void> => {
    const target = targetId.trim();
    if (!target) {
      setError('target project ID is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const opts = { config, persistConfig: setConfig, credentials };
      const r =
        source.kind === 'project'
          ? await runMigrate(source.remoteProjectId, target, opts)
          : await runMigrateForCwd(source.cwd, target, opts);
      onDone({
        title: `Migrate · ${source.name}`,
        lines: [
          r.action === 'migrated'
            ? `${r.sourceRemoteId} → ${r.targetRemoteId}`
            : `joined ${r.targetRemoteId} — future syncs upload there`,
        ],
        ok: true,
      });
    } catch (e: unknown) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useScreenInput((input, key) => {
    if (busy) return;
    if (key.escape) {
      onClose();
      return;
    }
    if (key.return) {
      void doSubmit();
      return;
    }
    setTargetId((v) => applyTextKey(v, input, key));
    setError(null);
  });

  return (
    <ScreenFrame
      title="Migrate"
      subtitle={source.name}
      footer={
        <HintBar
          hints={[
            ['enter', 'migrate'],
            ['esc', 'cancel'],
          ]}
        />
      }
    >
      <Box flexDirection="column">
        <Text>
          {'Migrate '}
          <Text color={theme.brand}>{`‹${source.name}›`}</Text>
          {' into another project.'}
        </Text>
        {neverSynced ? (
          <Text color={theme.dim}>
            {'  never synced — joins the target; the first sync uploads there'}
          </Text>
        ) : (
          <Text color={theme.dim}>
            {`  source project ID  ${source.remoteProjectId}`}
          </Text>
        )}
        <Box marginTop={1}>
          <Text color={theme.brand}>{'❯ '}</Text>
          <Text>{'target project ID  '}</Text>
          <TextInput
            value={targetId}
            focused={!busy}
            placeholder="12-char nanoid"
          />
        </Box>
        {neverSynced ? null : (
          <Text color={theme.dim}>
            Moves the data on the server; local sync state follows the target.
          </Text>
        )}
        <Text> </Text>
        {busy ? <Spinner label="migrating…" /> : null}
        {error ? <Text color={theme.err}>{`✗ ${error}`}</Text> : null}
      </Box>
    </ScreenFrame>
  );
}
