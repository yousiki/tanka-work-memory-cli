import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  claudeEncodedDir,
  countSessionsForProject,
  coworkAnchorFor,
  coworkSessionsRoot,
  cwdEqualsAny,
  cwdMatchesAny,
  discoverSessionsForProject,
  expandToWorktreeUnion,
  foldWorktreesToOwner,
  owningWorktree,
  type SessionRef,
  syntheticCwdFor,
} from '../src/discovery/sessions';

test('discoverSessionsForProject with no cwds discovers nothing', () => {
  assert.deepEqual(discoverSessionsForProject([]), []);
});

// Claude Code names a project's session dir by replacing EVERY non-alphanumeric char with '-',
// not just path separators. Verified against a real Windows install: the dir for
// `C:\数据\工作\dyj\dyj_autotest` on disk was `C--------dyj-dyj-autotest`. Guard against anyone
// "simplifying" this back to a separators-only rule, which silently breaks Windows/CJK paths.
test('claudeEncodedDir collapses every non-alphanumeric char (Windows + CJK)', () => {
  assert.equal(
    claudeEncodedDir('C:\\数据\\工作\\dyj\\dyj_autotest'),
    'C--------dyj-dyj-autotest',
  );
  // POSIX: separators and dots fold too — matches Claude Code's ~/.claude/projects naming.
  assert.equal(
    claudeEncodedDir('/Users/brian/.config/app'),
    '-Users-brian--config-app',
  );
});

// The other half of the Windows bug: Claude Code logs a cwd's drive letter inconsistently
// (`d:\…` vs `D:\…`), so matching must be case-insensitive on Windows or half a project's
// sessions vanish. We can't exercise the win32 branch on a POSIX CI runner, so we inject a
// lowercasing `fold` to simulate it. The injected fold is the ONLY Windows-specific knob.
test('cwdMatchesAny folds case when asked (Windows drive-letter drift), without merging distinct paths', () => {
  const lower = (p: string) => p.toLowerCase();
  const roots = [resolve('/Foo/Bar/proj')];

  // Registered with one case, session recorded with another → still matches under fold.
  assert.equal(cwdMatchesAny(resolve('/foo/bar/proj'), roots, lower), true);
  assert.equal(cwdMatchesAny(resolve('/foo/bar/proj/sub'), roots, lower), true);

  // Default fold is the platform one — on POSIX it's a no-op, so case-sensitive (the old behavior).
  assert.equal(cwdMatchesAny(resolve('/foo/bar/proj'), roots), false);

  // Folding case must NOT merge genuinely different paths (the "c: vs d:" guarantee).
  assert.equal(cwdMatchesAny(resolve('/Foo/Other'), roots, lower), false);
  // A path that merely shares a string prefix with a root must not match (the `+ path.sep`
  // boundary): `…/projextra` is not inside `…/proj`.
  assert.equal(
    cwdMatchesAny(resolve('/Foo/Bar/projextra'), roots, lower),
    false,
  );

  // Undefined candidate never matches.
  assert.equal(cwdMatchesAny(undefined, roots, lower), false);
});

// Exact-only matching (Codex, and the predicate behind Claude's dir filter): a session counts iff
// its cwd IS a root, never a root's subdirectory. The counterpart to cwdMatchesAny's at-or-beneath
// test above — guard the two don't drift back together.
test('cwdEqualsAny matches a root exactly but never its subdirectory', () => {
  const lower = (p: string) => p.toLowerCase();
  const roots = [resolve('/Foo/Bar/proj'), resolve('/Foo/Bar/proj-wt')];

  // Exact root (incl. a worktree root) matches; a subdirectory of a root does NOT.
  assert.equal(cwdEqualsAny(resolve('/Foo/Bar/proj'), roots), true);
  assert.equal(cwdEqualsAny(resolve('/Foo/Bar/proj-wt'), roots), true);
  assert.equal(cwdEqualsAny(resolve('/Foo/Bar/proj/sub'), roots), false);
  assert.equal(cwdEqualsAny(resolve('/Foo/Bar/proj/a/b'), roots), false);

  // Case folding (Windows drive-letter drift) still applies to the EXACT comparison…
  assert.equal(cwdEqualsAny(resolve('/foo/bar/proj'), roots, lower), true);
  // …but a folded subdirectory is still not an exact match.
  assert.equal(cwdEqualsAny(resolve('/foo/bar/proj/sub'), roots, lower), false);

  // A string-prefix sibling (`…/projextra`) is neither equal nor under — never matches.
  assert.equal(cwdEqualsAny(resolve('/Foo/Bar/projextra'), roots), false);
  // Undefined candidate never matches.
  assert.equal(cwdEqualsAny(undefined, roots), false);
});

// All-mode grouping: a repo's worktrees fold under the main worktree (git lists it FIRST) so they
// share one directory entry. A non-git cwd (worktreesOf → []) stays itself.
test('foldWorktreesToOwner folds worktree cwds onto the owning main worktree', () => {
  const main = resolve('/repo');
  const wt = resolve('/repo-wt');
  const sub = resolve('/repo/app-web'); // a plain SUBDIR of main — NOT a worktree
  const solo = resolve('/elsewhere/solo');
  // `git worktree list` lists only worktree ROOTS, main first — the same output whether run from a
  // worktree root OR from a subdir of one (the subdir is part of the main worktree). solo is non-git.
  const worktreesOf = (cwd: string): string[] => {
    if (cwd === main || cwd === wt || cwd === sub) return [main, wt];
    return [];
  };
  const ref = (id: string, cwd: string): SessionRef => ({
    id,
    agent: 'claude-code',
    path: `${cwd}/${id}.jsonl`,
    cwd,
    sizeBytes: 0,
    mtimeMs: 0,
    meta: {},
    sidecarFiles: [],
  });
  const calls: string[] = [];
  const counting = (cwd: string): string[] => {
    calls.push(cwd);
    return worktreesOf(cwd);
  };

  const refs = [
    ref('a', wt),
    ref('b', main),
    ref('c', wt),
    ref('d', solo),
    ref('e', sub),
  ];
  const out = foldWorktreesToOwner(refs, counting);

  // Worktree sessions (a, c) and the main session (b) all land on the main root; solo stays put;
  // the SUBDIR session (e) stays on app-web — it is NOT a worktree, so it must not fold into main.
  assert.deepEqual(
    out.map((r) => r.cwd),
    [main, main, main, solo, sub],
  );
  // Real path is untouched (method A only rewrites cwd) — wt session keeps its worktree path.
  assert.equal(out[0]!.path, `${wt}/a.jsonl`);
  // Memoised: one lookup per DISTINCT cwd (wt, main, solo, sub), not per ref.
  assert.deepEqual(calls, [wt, main, solo, sub]);
});

// The single grouping rule shared by 'all'-mode folding and select-mode ScanModal: a worktree root
// folds onto its main worktree; a subdir of a repo, and a non-git dir, stay themselves (so any dir
// you ran a coding agent in becomes its own project — git not required).
test('owningWorktree folds worktree roots but keeps subdirs and non-git dirs', () => {
  const main = resolve('/repo');
  const wt = resolve('/repo-wt');
  const sub = resolve('/repo/app-web'); // subdir of main — not a worktree
  const nogit = resolve('/scratch/notes'); // no git repo at all
  const worktreesOf = (cwd: string): string[] => {
    if (cwd === main || cwd === wt || cwd === sub) return [main, wt]; // git lists roots, main first
    return []; // non-git → no worktrees
  };
  assert.equal(owningWorktree(main, worktreesOf), main); // main stays itself
  assert.equal(owningWorktree(wt, worktreesOf), main); // worktree folds onto main
  assert.equal(owningWorktree(sub, worktreesOf), sub); // subdir stays itself
  assert.equal(owningWorktree(nogit, worktreesOf), nogit); // non-git stays itself
});

// A worktree ROOT pulls its sibling worktrees into the discovery roots; a SUBDIR must NOT pull in
// its parent repo. `git worktree list` run from a subdir returns the parent's worktrees (main
// first) — folding those in would make app-web's session list show omne-next's sessions (the
// child-shows-parent bug). Same worktree-root guard as owningWorktree.
test('expandToWorktreeUnion expands worktree roots but never a subdir into its parent repo', () => {
  const main = resolve('/repo');
  const wt = resolve('/repo-wt');
  const sub = resolve('/repo/app-web'); // subdir of main — not a worktree
  const solo = resolve('/elsewhere/solo'); // non-git
  const worktreesOf = (cwd: string): string[] => {
    // git lists worktree ROOTS (main first); a subdir's lookup returns the same parent list,
    // never the subdir itself; a non-git dir yields nothing.
    if (cwd === main || cwd === wt || cwd === sub) return [main, wt];
    return [];
  };
  // A worktree root (main, or a linked worktree) brings in the whole repo's worktrees.
  assert.deepEqual(
    [...expandToWorktreeUnion([main], worktreesOf)].sort(),
    [main, wt].sort(),
  );
  assert.deepEqual(
    [...expandToWorktreeUnion([wt], worktreesOf)].sort(),
    [main, wt].sort(),
  );
  // The bug fix: a subdir contributes ONLY itself — the parent repo is NOT pulled in.
  assert.deepEqual(expandToWorktreeUnion([sub], worktreesOf), [sub]);
  // Non-git dir stays alone.
  assert.deepEqual(expandToWorktreeUnion([solo], worktreesOf), [solo]);
});

test('discoverSessionsForProject over an empty dir yields no sessions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-sessions-'));
  try {
    // A real but session-free directory: no agent has ever recorded a session whose cwd is here.
    assert.deepEqual(discoverSessionsForProject([dir]), []);
    assert.equal(countSessionsForProject([dir]), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('countSessionsForProject never throws', () => {
  assert.equal(countSessionsForProject([]), 0);
  assert.equal(
    typeof countSessionsForProject(['/nonexistent/path/xyz']),
    'number',
  );
});

// A Cowork session run without granting a specific folder records no userSelectedFolders[] and
// lands in Cowork's default workspace root, ~/Claude. We anchor those folder-less sessions to a
// project ONLY when that project registered ~/Claude as a cwd — an opt-in catch-all.
test('coworkAnchorFor: folder-less session anchors to ~/Claude only when it is a registered cwd', () => {
  const claude = resolve('/Users/me/Claude');
  const other = resolve('/Users/me/work/proj');

  // No userSelectedFolders + ~/Claude registered → anchors to the catch-all root.
  assert.equal(coworkAnchorFor([], [other, claude], claude), claude);
  // No userSelectedFolders + ~/Claude NOT registered → out of scope.
  assert.equal(coworkAnchorFor([], [other], claude), undefined);

  // Real cwds are always full absolute paths but may arrive non-normalised — a trailing slash or a
  // "."/".." segment must still match the default root (we path.resolve both sides, not string-eq).
  assert.equal(coworkAnchorFor([], ['/Users/me/Claude/'], claude), claude);
  assert.equal(
    coworkAnchorFor([], ['/Users/me/sub/../Claude'], claude),
    claude,
  );
});

test('coworkAnchorFor: a session that named folders never falls back to the ~/Claude catch-all', () => {
  const claude = resolve('/Users/me/Claude');
  const proj = resolve('/Users/me/work/proj');
  const sub = resolve('/Users/me/work/proj/sub');

  // A named folder that overlaps a root anchors to that folder (the original rule), not the catch-all.
  assert.equal(coworkAnchorFor([sub], [proj], proj), sub);
  // Roots may arrive un-normalised (trailing slash) — coworkAnchorFor resolves them so overlap holds.
  assert.equal(coworkAnchorFor([sub], ['/Users/me/work/proj/'], proj), sub);
  // A named folder equal to ~/Claude anchors to it like any other overlapping grant.
  assert.equal(coworkAnchorFor([claude], [claude], claude), claude);

  // The sharp edge: folders were named but none overlap → skipped, EVEN THOUGH ~/Claude is
  // registered. An unmatched grant is an explicit elsewhere, not a folder-less default — it must
  // not be swept into the catch-all.
  assert.equal(
    coworkAnchorFor([resolve('/somewhere/else')], [claude], claude),
    undefined,
  );

  // Folder-less is judged on the RAW grant, not the string-filtered list: a non-empty grant we
  // couldn't parse (all non-string junk) means the user pointed Cowork *somewhere*, so it must NOT
  // fall into the ~/Claude catch-all even though every parsed entry dropped out.
  assert.equal(coworkAnchorFor([123, null], [claude], claude), undefined);
  // A non-array grant (absent/garbage field) IS folder-less → catch-all applies.
  assert.equal(coworkAnchorFor(undefined, [claude], claude), claude);
});

// Cowork now runs on Windows (sessions under %APPDATA%\Claude), so its folder matching must absorb
// the same drive-letter case drift Claude Code suffers. We inject a lowercasing fold to simulate
// win32 on a POSIX runner (same trick as the cwdMatchesAny test).
test('coworkAnchorFor folds case when asked, so Windows drive-letter drift does not drop sessions', () => {
  const lower = (p: string) => p.toLowerCase();
  const root = resolve('/D/work/proj');

  // A grant recorded with a different drive-letter case still overlaps under fold…
  assert.equal(
    coworkAnchorFor(
      [resolve('/d/work/proj/sub')],
      [root],
      resolve('/x/Claude'),
      lower,
    ),
    resolve('/d/work/proj/sub'),
  );
  // …but the default (POSIX no-op) fold keeps the two cases distinct.
  assert.equal(
    coworkAnchorFor(
      [resolve('/d/work/proj/sub')],
      [root],
      resolve('/x/Claude'),
    ),
    undefined,
  );

  // The folder-less catch-all folds too — ~/Claude registered with different case still matches.
  // The returned anchor is coworkDefaultRoot itself (claudeUpper), NOT the registered root string —
  // fold is only for the comparison, so the anchor keeps coworkDefaultRoot's casing.
  const claudeUpper = resolve('/Users/Me/Claude');
  assert.equal(
    coworkAnchorFor([], [resolve('/users/me/claude')], claudeUpper, lower),
    claudeUpper,
  );
});

// coworkSessionsRoot resolves Claude Desktop's appData dir per platform — injectable so all three
// branches run on one host. (path.join uses the host separator; we assert via join() to match.)
test('coworkSessionsRoot picks the right appData base per platform', () => {
  const home = resolve('/home/me');
  assert.equal(
    coworkSessionsRoot('darwin', {}, home),
    join(
      home,
      'Library',
      'Application Support',
      'Claude',
      'local-agent-mode-sessions',
    ),
  );
  // Windows honours %APPDATA% when set…
  assert.equal(
    coworkSessionsRoot('win32', { APPDATA: resolve('/roaming') }, home),
    join(resolve('/roaming'), 'Claude', 'local-agent-mode-sessions'),
  );
  // …and falls back to ~/AppData/Roaming when APPDATA is unset or blank.
  assert.equal(
    coworkSessionsRoot('win32', { APPDATA: '   ' }, home),
    join(home, 'AppData', 'Roaming', 'Claude', 'local-agent-mode-sessions'),
  );
  // Linux / others → ~/.config (Electron's appData default) when XDG_CONFIG_HOME is unset…
  assert.equal(
    coworkSessionsRoot('linux', {}, home),
    join(home, '.config', 'Claude', 'local-agent-mode-sessions'),
  );
  // …honouring $XDG_CONFIG_HOME when set (Electron's Linux appData behaviour).
  assert.equal(
    coworkSessionsRoot('linux', { XDG_CONFIG_HOME: resolve('/xdg') }, home),
    join(resolve('/xdg'), 'Claude', 'local-agent-mode-sessions'),
  );
});

test('syntheticCwdFor derives a project from the cwd basename (no git involved)', () => {
  const p = syntheticCwdFor('/Users/me/Code/My Project');
  assert.equal(p.id, 'my-project');
  assert.equal(p.name, 'My Project');
  assert.equal(p.cwd, '/Users/me/Code/My Project');
});

test('syntheticCwdFor falls back to a stable id for an empty basename', () => {
  const p = syntheticCwdFor('/');
  assert.equal(p.id, 'sessions');
});
