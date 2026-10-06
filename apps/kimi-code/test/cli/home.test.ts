import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureForkHome } from '#/cli/home';

describe('ensureForkHome', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lacrous-kimi-home-'));
    env = {};
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function legacyHome(): string {
    return join(root, '.kimi-code');
  }

  function forkHome(): string {
    return join(root, '.lacrous-kimi');
  }

  function writeLegacyLayout(): void {
    mkdirSync(join(legacyHome(), 'sessions'), { recursive: true });
    mkdirSync(join(legacyHome(), 'cache', 'rg'), { recursive: true });
    mkdirSync(join(legacyHome(), 'logs'), { recursive: true });
    writeFileSync(join(legacyHome(), 'config.toml'), 'default_model = "k2"\n');
    writeFileSync(join(legacyHome(), 'sessions', 'sess_1.jsonl'), '{}\n');
    writeFileSync(join(legacyHome(), 'cache', 'rg', 'rg.bin'), 'binary');
    writeFileSync(join(legacyHome(), 'logs', 'cli.log'), 'noise\n');
  }

  it('respects an explicit KIMI_CODE_HOME and never migrates into it', () => {
    mkdirSync(legacyHome(), { recursive: true });
    writeLegacyLayout();
    env['KIMI_CODE_HOME'] = join(root, 'custom-home');

    const outcome = ensureForkHome(env, root);

    expect(outcome).toEqual({
      home: join(root, 'custom-home'),
      defaultApplied: false,
      migrated: false,
    });
    expect(existsSync(join(root, 'custom-home'))).toBe(false);
  });

  it('defaults the fork home and records it in the environment', () => {
    const outcome = ensureForkHome(env, root);

    expect(outcome).toEqual({
      home: forkHome(),
      defaultApplied: true,
      migrated: false,
    });
    expect(env['KIMI_CODE_HOME']).toBe(forkHome());
  });

  it('copies user data from the legacy home, skipping regenerable state', () => {
    writeLegacyLayout();

    const outcome = ensureForkHome(env, root);

    expect(outcome.migrated).toBe(true);
    expect(outcome.legacyHome).toBe(legacyHome());
    expect(existsSync(join(forkHome(), 'config.toml'))).toBe(true);
    expect(existsSync(join(forkHome(), 'sessions', 'sess_1.jsonl'))).toBe(true);
    expect(existsSync(join(forkHome(), 'migrated-from-kimi-code.json'))).toBe(true);
    expect(existsSync(join(forkHome(), 'cache'))).toBe(false);
    expect(existsSync(join(forkHome(), 'logs'))).toBe(false);
    expect(existsSync(join(legacyHome(), 'config.toml'))).toBe(true);
    expect(existsSync(join(legacyHome(), 'cache', 'rg', 'rg.bin'))).toBe(true);
    expect(readdirSync(root).filter((entry) => entry.includes('migrating'))).toEqual([]);
  });

  it('never touches an existing fork home', () => {
    writeLegacyLayout();
    mkdirSync(forkHome(), { recursive: true });
    writeFileSync(join(forkHome(), 'fresh-config.toml'), 'mine = true\n');

    const outcome = ensureForkHome(env, root);

    expect(outcome.migrated).toBe(false);
    expect(existsSync(join(forkHome(), 'fresh-config.toml'))).toBe(true);
    expect(existsSync(join(forkHome(), 'config.toml'))).toBe(false);
  });

  it('reports a migration failure instead of throwing, leaving nothing behind', () => {
    writeFileSync(legacyHome(), 'not a directory\n');

    const outcome = ensureForkHome(env, root);

    expect(outcome.defaultApplied).toBe(true);
    expect(outcome.migrated).toBe(false);
    expect(outcome.migrationError).toBeDefined();
    expect(outcome.legacyHome).toBe(legacyHome());
    expect(existsSync(forkHome())).toBe(false);
    expect(readdirSync(root).filter((entry) => entry.includes('migrating'))).toEqual([]);
  });
});
