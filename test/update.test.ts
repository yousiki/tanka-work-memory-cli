import { describe, expect, test } from 'bun:test';

/**
 * Unit tests for the pure helpers in src/update.ts.  Network-hitting functions
 * (checkForUpdate, performUpdate) are not exercised here — they depend on real
 * GitHub API calls and filesystem mutations.
 */

// ── We test the private helpers via the module's exported surface, plus we
//    re-implement the internals here to verify the logic in isolation. ────────

describe('cmpSemver', () => {
  // Re-implement locally since the function is not exported.
  function cmpSemver(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = pa[i] ?? 0;
      const nb = pb[i] ?? 0;
      if (na > nb) return 1;
      if (na < nb) return -1;
    }
    return 0;
  }

  test('equal versions', () => {
    expect(cmpSemver('1.2.0', '1.2.0')).toBe(0);
  });

  test('newer major', () => {
    expect(cmpSemver('2.0.0', '1.9.9')).toBe(1);
  });

  test('newer minor', () => {
    expect(cmpSemver('1.3.0', '1.2.9')).toBe(1);
  });

  test('newer patch', () => {
    expect(cmpSemver('1.2.1', '1.2.0')).toBe(1);
  });

  test('older version', () => {
    expect(cmpSemver('1.1.0', '1.2.0')).toBe(-1);
  });

  test('different length (trailing zero)', () => {
    expect(cmpSemver('1.2', '1.2.0')).toBe(0);
  });

  test('different length (longer is newer)', () => {
    expect(cmpSemver('1.2.0.1', '1.2.0')).toBe(1);
  });
});

describe('stripV', () => {
  function stripV(tag: string): string {
    return tag.replace(/^v/, '');
  }

  test('removes v prefix', () => {
    expect(stripV('v1.2.0')).toBe('1.2.0');
  });

  test('no-op without prefix', () => {
    expect(stripV('1.2.0')).toBe('1.2.0');
  });
});

describe('formatBytes', () => {
  // Import the exported function.
  const { formatBytes } =
    require('../src/update') as typeof import('../src/update');

  test('bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  test('kilobytes', () => {
    expect(formatBytes(2048)).toBe('2.0 KB');
  });

  test('megabytes', () => {
    expect(formatBytes(85 * 1024 * 1024)).toBe('85.0 MB');
  });
});

describe('isCompiledBinary', () => {
  const { isCompiledBinary } =
    require('../src/update') as typeof import('../src/update');

  test('returns false when running under bun', () => {
    // In test, process.execPath is the bun binary.
    expect(isCompiledBinary()).toBe(false);
  });
});
