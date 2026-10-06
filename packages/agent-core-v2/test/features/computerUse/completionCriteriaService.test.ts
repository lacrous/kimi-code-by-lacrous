import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CompletionCriteriaService,
  type ICompletionCriteriaService,
} from '#/features/computerUse/completionCriteriaService';
import { VERIFICATION_ENABLED_ENV, isVerificationEnabled } from '#/features/computerUse/verificationFlag';
import type { Evidence } from '#/features/computerUse/goalVerifier';

const dirs: string[] = [];
const saved: { readonly key: string; readonly value: string | undefined }[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  for (const entry of saved.splice(0)) {
    if (entry.value === undefined) {
      delete process.env[entry.key];
    } else {
      process.env[entry.key] = entry.value;
    }
  }
});

function setEnv(key: string, value: string): void {
  saved.push({ key, value: process.env[key] });
  process.env[key] = value;
}

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-criteria-'));
  dirs.push(dir);
  return dir;
}

async function writeCriteria(root: string, goalId: string, body: unknown): Promise<void> {
  const dir = join(root, '.kimi', 'goals', goalId);
  await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }));
  await writeFile(join(dir, 'criteria.json'), JSON.stringify(body), 'utf8');
}

describe('isVerificationEnabled', () => {
  it('is off unless the env var is set to a truthy value', () => {
    expect(isVerificationEnabled({})).toBe(false);
    expect(isVerificationEnabled({ [VERIFICATION_ENABLED_ENV]: '' })).toBe(false);
    expect(isVerificationEnabled({ [VERIFICATION_ENABLED_ENV]: '0' })).toBe(false);
    expect(isVerificationEnabled({ [VERIFICATION_ENABLED_ENV]: 'false' })).toBe(false);
    expect(isVerificationEnabled({ [VERIFICATION_ENABLED_ENV]: '1' })).toBe(true);
    expect(isVerificationEnabled({ [VERIFICATION_ENABLED_ENV]: 'true' })).toBe(true);
  });
});

describe('CompletionCriteriaService', () => {
  it('returns no criteria for a goal that declares none', async () => {
    const service = new CompletionCriteriaService({ workspaceDir: await workspace() });

    expect(await service.criteriaFor('missing')).toEqual([]);
  });

  it('returns no criteria when the file is not valid json', async () => {
    const root = await workspace();
    await writeCriteria(root, 'g1', 'not json at all');
    const service = new CompletionCriteriaService({ workspaceDir: root });

    expect(await service.criteriaFor('g1')).toEqual([]);
  });

  it('reads declared checks', async () => {
    const root = await workspace();
    await writeCriteria(root, 'g1', {
      criteria: [{ id: 'build', description: 'the build passes', check: { kind: 'command_succeeded', command: 'true' } }],
    });
    const service = new CompletionCriteriaService({ workspaceDir: root });

    expect(await service.criteriaFor('g1')).toEqual([
      { id: 'build', description: 'the build passes', check: { kind: 'command_succeeded', command: 'true' } },
    ]);
  });

  it('treats a criterion with no check as undecidable rather than passing it', async () => {
    const root = await workspace();
    await writeCriteria(root, 'g1', {
      criteria: [{ id: 'taste', description: 'the copy reads well' }],
    });
    const service = new CompletionCriteriaService({ workspaceDir: root });

    const [only] = await service.criteriaFor('g1');

    expect(only).toMatchObject({ id: 'taste', undecidable: true });
    expect(only !== undefined && 'reason' in only ? only.reason : '').toContain(
      'no machine-checkable criterion',
    );
  });

  it('keeps an explicit undecidable marker and its reason', async () => {
    const root = await workspace();
    await writeCriteria(root, 'g1', {
      criteria: [{ id: 'taste', description: 'reads well', undecidable: true, reason: 'subjective' }],
    });
    const service = new CompletionCriteriaService({ workspaceDir: root });

    const [only] = await service.criteriaFor('g1');

    expect(only !== undefined && 'reason' in only ? only.reason : '').toBe('subjective');
  });

  it('starts with no evidence and no facts', async () => {
    const service: ICompletionCriteriaService = new CompletionCriteriaService();

    expect(await service.evidenceFor('g1')).toEqual([]);
    expect(service.factsFor('g1')).toEqual({});
  });

  it('records facts and reads them back', () => {
    const service = new CompletionCriteriaService();
    service.recordFact('g1', 'rows', 10);

    expect(service.factsFor('g1')).toEqual({ rows: 10 });
  });

  it('keeps facts per goal', () => {
    const service = new CompletionCriteriaService();
    service.recordFact('g1', 'rows', 10);
    service.recordFact('g2', 'rows', 3);

    expect(service.factsFor('g1')).toEqual({ rows: 10 });
    expect(service.factsFor('g2')).toEqual({ rows: 3 });
  });

  it('overwrites a fact recorded twice', () => {
    const service = new CompletionCriteriaService();
    service.recordFact('g1', 'rows', 10);
    service.recordFact('g1', 'rows', 12);

    expect(service.factsFor('g1')).toEqual({ rows: 12 });
  });

  it('records and returns evidence', async () => {
    const service = new CompletionCriteriaService();
    const item: Evidence = {
      id: 'e1',
      kind: 'screenshot',
      summary: 'the dashboard',
      observedAt: 1,
      beforeClaim: true,
    };
    service.recordEvidence('g1', item);

    expect(await service.evidenceFor('g1')).toEqual([item]);
  });
});

describe('verification env plumbing', () => {
  it('reads the flag from the process environment at call time', () => {
    expect(isVerificationEnabled()).toBe(false);
    setEnv(VERIFICATION_ENABLED_ENV, '1');
    expect(isVerificationEnabled()).toBe(true);
  });
});
