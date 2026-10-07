#!/usr/bin/env node
/**
 * Runs the Lacrous Kimi Code CLI from this checkout instead of an installed binary.
 *
 * Author: lacrous (fork of MoonshotAI/kimi-code).
 *
 * Why a wrapper script rather than a plain package.json script: pnpm forwards
 * the `--` separator as a literal argument, so `pnpm run kimi -- provider list`
 * would hand the CLI `--` as its first argument and it would fail on an
 * "unknown command". Dropping a leading `--` makes both forms work.
 *
 * Also points KIMI_CODE_HOME at a repo-local directory so the dev run never
 * reads or writes the installed `kimi`'s config (~/.kimi-code/config.toml).
 * Set KIMI_CODE_HOME yourself to override, e.g.
 *   KIMI_CODE_HOME=$HOME/.kimi-code node scripts/kimi-dev.mjs provider list
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// `import.meta.dirname` (Node >= 20.11) rather than
// dirname(fileURLToPath(import.meta.url)) — same result, and it keeps the
// type-aware lint pass from flagging the helper imports as unused.
const repoRoot = resolve(import.meta.dirname, '..');
const appRoot = resolve(repoRoot, 'apps/kimi-code');

process.env.KIMI_CODE_HOME ??= resolve(repoRoot, '.kimi-dev-home');
mkdirSync(process.env.KIMI_CODE_HOME, { recursive: true });

const argv = process.argv.slice(2);
if (argv[0] === '--') argv.shift();

const child = spawn(
  'npx',
  [
    'tsx',
    '--tsconfig',
    './tsconfig.dev.json',
    '--import',
    '../../build/register-raw-text-loader.mjs',
    './src/main.ts',
    ...argv,
  ],
  { cwd: appRoot, stdio: 'inherit', env: process.env },
);

child.on('exit', (code, signal) => {
  process.exit(signal !== null ? 1 : (code ?? 0));
});