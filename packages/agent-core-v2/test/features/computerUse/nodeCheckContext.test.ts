import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createNodeCheckContext } from '#/features/computerUse/nodeCheckContext';
import { verifyGoal, type Criterion } from '#/features/computerUse/goalVerifier';

const dirs: string[] = [];

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-check-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const criterion = (overrides: Partial<Criterion> = {}): Criterion => ({
  id: 'c1',
  description: 'the criterion holds',
  check: { kind: 'file_exists', path: 'a.txt' },
  ...overrides,
});

describe('createNodeCheckContext against the real filesystem', () => {
  it('resolves a relative path against the workspace', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'a.txt'), 'hello');
    const context = createNodeCheckContext([], { workspaceDir: dir });

    expect(await context.fileExists('a.txt')).toBe(true);
    expect(await context.fileExists('missing.txt')).toBe(false);
  });

  it('reads a file and reports its content', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'a.txt'), 'the build is green');
    const context = createNodeCheckContext([], { workspaceDir: dir });

    expect(await context.readFile('a.txt')).toBe('the build is green');
  });

  it('returns undefined for a file it cannot read', async () => {
    const dir = await workspace();
    const context = createNodeCheckContext([], { workspaceDir: dir });

    expect(await context.readFile('missing.txt')).toBeUndefined();
  });

  it('refuses to read a file larger than the cap', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'big.bin'), 'x'.repeat(4_096));
    const context = createNodeCheckContext([], { workspaceDir: dir, maxReadBytes: 1_024 });

    expect(await context.readFile('big.bin')).toBeUndefined();
  });

  it('treats a directory as existing', async () => {
    const dir = await workspace();
    await mkdirSafe(join(dir, 'sub'));
    const context = createNodeCheckContext([], { workspaceDir: dir });

    expect(await context.fileExists('sub')).toBe(true);
  });
});

describe('createNodeCheckContext against the real shell', () => {
  it('returns zero for a command that succeeds', async () => {
    const context = createNodeCheckContext([]);

    expect(await context.run('true')).toBe(0);
  });

  it('returns the exit code of a command that fails', async () => {
    const context = createNodeCheckContext([]);

    expect(await context.run('exit 3')).toBe(3);
  });

  it('supports a pipeline, not just a bare binary', async () => {
    const context = createNodeCheckContext([]);

    expect(await context.run('printf abc | grep -q b')).toBe(0);
    expect(await context.run('printf abc | grep -q z')).toBe(1);
  });

  it('reports a command that does not exist as a failure, not a crash', async () => {
    const context = createNodeCheckContext([]);

    expect(await context.run('definitely-not-a-real-binary-xyz')).toBeGreaterThan(0);
  });
});

describe('verifyGoal with the real machine', () => {
  it('verifies a goal whose file exists and whose command passes', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'report.md'), '# done');
    const context = createNodeCheckContext([], { workspaceDir: dir });

    const result = await verifyGoal({
      criteria: [
        {
          id: 'file',
          description: 'report.md exists',
          check: { kind: 'file_exists', path: 'report.md' },
        },
        {
          id: 'content',
          description: 'report.md has a heading',
          check: { kind: 'file_contains', path: 'report.md', pattern: '# done' },
        },
        {
          id: 'cmd',
          description: 'the tests pass',
          check: { kind: 'command_succeeded', command: 'true' },
        },
      ],
      evidence: [],
      facts: {},
      context,
    });

    expect(result.criteria.map((c) => c.criterionId)).toEqual(['file', 'content', 'cmd']);
    expect(result.criteria.every((c) => c.satisfied)).toBe(true);
    expect(result.verdict).toBe('verified');
  });

  it('fails a goal whose file is absent on the real disk', async () => {
    const dir = await workspace();
    const context = createNodeCheckContext([], { workspaceDir: dir });

    const result = await verifyGoal({
      criteria: [
        {
          id: 'file',
          description: 'missing.md exists',
          check: { kind: 'file_exists', path: 'missing.md' },
        },
      ],
      evidence: [],
      facts: {},
      context,
    });

    expect(result.verdict).toBe('unverified');
    expect(result.summary).toContain('missing.md');
  });
});

async function mkdirSafe(path: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path, { recursive: true });
}
