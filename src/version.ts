/**
 * Single source of truth for the TUI's version string — read from package.json
 * so there's exactly one place to bump. bun's `--compile` inlines the imported
 * JSON at build time, so this stays a constant in the self-contained binary
 * (no filesystem read at runtime).
 */
import pkg from '../package.json';

export const WM_TUI_VERSION: string = pkg.version;
