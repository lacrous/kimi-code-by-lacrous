import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ActionLog, type ActionLogEntry } from '#/features/computerUse/actionLog';
import type { ActionRecord } from '#/features/computerUse/observation';

const dirs: string[] = [];

async function logIn(dir?: string): Promise<ActionLog> {
  const base = dir ?? (await mkdtemp(join(tmpdir(), 'kimi-log-')));
  if (dir === undefined) dirs.push(base);
  return new ActionLog(join(base, 'actions.jsonl'));
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function record(overrides: Partial<ActionRecord> = {}): ActionRecord {
  return {
    action: 'browser.click',
    arguments: { target: 'button "Save"' },
    startedAt: 1_700_000_000_000,
    durationMs: 42,
    success: true,
    failureClass: undefined,
    error: undefined,
    ...overrides,
  };
}

function entry(overrides: Partial<ActionLogEntry> = {}): ActionLogEntry {
  return {
    at: 1_700_000_000_000,
    action: 'browser.click',
    arguments: {},
    durationMs: 42,
    success: true,
    failureClass: undefined,
    error: undefined,
    screenshotRef: undefined,
    goalId: 'goal-1',
    taskId: 'task-1',
    ...overrides,
  };
}

describe('ActionLog', () => {
  it('returns nothing when the log does not exist', async () => {
    const log = await logIn();

    expect(await log.read()).toEqual([]);
    expect(await log.count()).toBe(0);
  });

  it('appends entries in order', async () => {
    const log = await logIn();
    await log.append(entry({ action: 'first' }));
    await log.append(entry({ action: 'second' }));

    expect((await log.read()).map((e) => e.action)).toEqual(['first', 'second']);
  });

  it('creates the directory it needs', async () => {
    const base = await mkdtemp(join(tmpdir(), 'kimi-log-'));
    dirs.push(base);
    const log = new ActionLog(join(base, 'nested', 'deep', 'actions.jsonl'));

    await log.append(entry());

    expect(await log.count()).toBe(1);
  });

  it('skips a malformed line instead of failing to read', async () => {
    const base = await mkdtemp(join(tmpdir(), 'kimi-log-'));
    dirs.push(base);
    const log = await logIn(base);
    await log.append(entry({ action: 'good-1' }));
    await appendTruncated(log.path);
    await log.append(entry({ action: 'good-2' }));

    expect((await log.read()).map((e) => e.action)).toEqual(['good-1', 'good-2']);
  });

  it('filters by goal and task', async () => {
    const log = await logIn();
    await log.append(entry({ goalId: 'g1', taskId: 't1' }));
    await log.append(entry({ goalId: 'g1', taskId: 't2' }));
    await log.append(entry({ goalId: 'g2', taskId: 't1' }));

    expect(await log.count({ goalId: 'g1' })).toBe(2);
    expect(await log.count({ taskId: 't1' })).toBe(2);
    expect(await log.count({ goalId: 'g2', taskId: 't1' })).toBe(1);
  });

  it('returns the most recent entries for a limit', async () => {
    const log = await logIn();
    for (let i = 0; i < 5; i++) {
      await log.append(entry({ action: `a${String(i)}` }));
    }

    expect((await log.read({ limit: 2 })).map((e) => e.action)).toEqual(['a3', 'a4']);
  });

  it('lists only failures', async () => {
    const log = await logIn();
    await log.append(entry({ success: true }));
    await log.append(entry({ success: false, failureClass: 'network' }));

    const failures = await log.failures();

    expect(failures).toHaveLength(1);
    expect(failures[0]?.failureClass).toBe('network');
  });

  it('converts an action record into a log entry', async () => {
    const log = await logIn();

    const converted = log.record(record(), { goalId: 'g1', screenshotRef: 'media:abc' });
    await log.append(converted);

    const [stored] = await log.read();
    expect(stored).toMatchObject({
      action: 'browser.click',
      goalId: 'g1',
      screenshotRef: 'media:abc',
      durationMs: 42,
    });
  });

  it('formats a readable timeline', async () => {
    const log = await logIn();
    await log.append(entry({ action: 'browser.navigate', success: true }));
    await log.append(
      entry({
        action: 'browser.click',
        success: false,
        failureClass: 'invalid_action',
        error: 'no such node',
      }),
    );

    const text = await log.format();

    expect(text).toContain('OK    browser.navigate');
    expect(text).toContain('FAIL  browser.click invalid_action: no such node');
  });

  it('says so when there is nothing to show', async () => {
    expect(await (await logIn()).format()).toBe('No actions recorded.');
  });
});

async function appendTruncated(path: string): Promise<void> {
  await writeFile(path, '{"action":"truncated","at":1\n', { flag: 'a' });
}
