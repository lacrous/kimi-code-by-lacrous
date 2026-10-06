import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const FORK_HOME_DIRNAME = '.lacrous-kimi';
export const LEGACY_HOME_DIRNAME = '.kimi-code';
export const MIGRATION_MARKER_FILENAME = 'migrated-from-kimi-code.json';

// Regenerable state that is not worth carrying over: the launcher bits, the
// downloaded tool caches, staged updates, and logs. Everything else in the
// legacy home (config, sessions, auth, plugins, history, ...) is user data.
const MIGRATION_SKIPPED_ENTRIES = new Set(['bin', 'cache', 'logs', 'updates']);

export interface ForkHomeOutcome {
  /** The data home the CLI must use from this point on. */
  readonly home: string;
  /** True when the home was resolved from an explicit KIMI_CODE_HOME. */
  readonly defaultApplied: boolean;
  /** True when the legacy home was copied into the fresh fork home. */
  readonly migrated: boolean;
  /** The legacy home a successful migration copied from. */
  readonly legacyHome?: string;
  /** Set when a migration was attempted but failed; the CLI starts fresh. */
  readonly migrationError?: string;
}

/**
 * Point the fork CLI at its own data home, isolated from an installed upstream
 * Kimi Code that shares the machine. `KIMI_CODE_HOME` always wins; otherwise
 * the fork defaults to `~/.lacrous-kimi` and, on the very first run, copies the
 * user data out of a legacy `~/.kimi-code` so existing sessions and config
 * follow. The legacy home is never modified or removed.
 */
export function ensureForkHome(
  env: NodeJS.ProcessEnv = process.env,
  osHomeDir: string = homedir(),
): ForkHomeOutcome {
  const configured = env['KIMI_CODE_HOME'];
  if (configured !== undefined && configured !== '') {
    return { home: configured, defaultApplied: false, migrated: false };
  }

  const home = join(osHomeDir, FORK_HOME_DIRNAME);
  const legacyHome = join(osHomeDir, LEGACY_HOME_DIRNAME);
  env['KIMI_CODE_HOME'] = home;
  const migration = migrateLegacyHome(legacyHome, home);
  return {
    home,
    defaultApplied: true,
    migrated: migration.migrated,
    legacyHome: migration.migrated || migration.error !== undefined ? legacyHome : undefined,
    migrationError: migration.error,
  };
}

function migrateLegacyHome(legacyHome: string, home: string): { migrated: boolean; error?: string } {
  if (!existsSync(legacyHome)) return { migrated: false };
  // An existing fork home means a previous run already set this up (or the
  // user created it deliberately); never merge or overwrite either way.
  if (existsSync(home)) return { migrated: false };

  const staging = join(dirname(home), `.${FORK_HOME_DIRNAME.slice(1)}.migrating-${process.pid}`);
  try {
    mkdirSync(dirname(home), { recursive: true });
    mkdirSync(staging);
    for (const entry of readdirSync(legacyHome)) {
      if (MIGRATION_SKIPPED_ENTRIES.has(entry)) continue;
      cpSync(join(legacyHome, entry), join(staging, entry), { recursive: true });
    }
    writeFileSync(
      join(staging, MIGRATION_MARKER_FILENAME),
      `${JSON.stringify({ from: legacyHome, migratedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    renameSync(staging, home);
    return { migrated: true };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    return {
      migrated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
