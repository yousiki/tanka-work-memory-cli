/**
 * First-run wizard — a resumable onboarding. Step 1 picks the run mode; the
 * remaining steps depend on it (All skips project selection). Each step reuses
 * the component the Board opens as a modal. Esc on a step goes *back* one step
 * (and quits from the first step), so you can move forward and back freely;
 * quitting leaves the step un-advanced so the next launch resumes here.
 */
import { useApp } from 'ink';
import type React from 'react';

import type { RunMode, WizardStep } from '../config/config';
import { CronModal } from '../modals/CronModal';
import { ModeScreen } from './ModeScreen';
import { ProjectsScreen } from './ProjectsScreen';
import { TankaConfigScreen } from './TankaConfigScreen';

/** The ordered steps for a given mode — tanka (token + device) comes before
 *  projects so the API is available when projects need to create/join remotely.
 *  All mode has no project-selection step. */
function order(mode: RunMode | undefined): WizardStep[] {
  return mode === 'all'
    ? ['mode', 'tanka', 'cron']
    : ['mode', 'tanka', 'projects', 'cron'];
}

export function Wizard({
  step,
  mode,
  onAdvance,
  onSetMode,
  onExit,
  rerun,
}: {
  step: WizardStep;
  mode: RunMode | undefined;
  onAdvance: (next: WizardStep) => void;
  onSetMode: (mode: RunMode) => void;
  /** quit/cancel handler — defaults to exiting the app (first-run); a re-run
   *  passes this to return to the Board (discarding the draft). */
  onExit?: () => void;
  /** re-run mode: Esc on any step cancels the whole thing (no step-back). */
  rerun?: boolean;
}): React.ReactElement {
  const { exit: appExit } = useApp();
  const exit = onExit ?? appExit;
  const steps = order(mode);
  const idx = Math.max(0, steps.indexOf(step));
  const total = steps.length;
  const label = (name: string): string => `Setup ${idx + 1}/${total} · ${name}`;
  const back = (): void => {
    const prev = idx > 0 ? steps[idx - 1]! : null;
    if (prev) onAdvance(prev);
    else exit();
  };
  // Esc steps back; a re-run additionally offers `c` to cancel the whole draft.
  const cancel = rerun ? () => exit() : undefined;

  if (step === 'mode') {
    return (
      <ModeScreen
        wizardLabel="Setup · run mode"
        current={mode}
        onPick={(m) => {
          onSetMode(m);
          onAdvance('tanka');
        }}
        onCancel={() => exit()}
      />
    );
  }
  if (step === 'tanka') {
    return (
      <TankaConfigScreen
        wizardLabel={label('Tanka upload target')}
        onSaved={() => onAdvance(mode === 'all' ? 'cron' : 'projects')}
        onCancel={() => exit()}
        onBack={back}
        onCancelAll={cancel}
      />
    );
  }
  if (step === 'projects') {
    return (
      <ProjectsScreen
        wizardLabel={label('projects')}
        onDone={() => onAdvance('cron')}
        onCancel={() => exit()}
        onBack={back}
        onCancelAll={cancel}
      />
    );
  }
  if (step === 'cron') {
    return (
      <CronModal
        wizardLabel={`${label('scheduled upload')} (default every 4h)`}
        onContinue={() => onAdvance('done')}
        onClose={() => exit()}
        onBack={back}
        onCancelAll={cancel}
      />
    );
  }
  // biome-ignore lint/complexity/noUselessFragments: renders nothing while satisfying the declared `React.ReactElement` return type (cannot return null).
  return <></>;
}
