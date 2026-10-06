import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createDecorator } from '#/_base/di/instantiation';

import type { Criterion, Evidence } from '#/features/computerUse/goalVerifier';

export interface CompletionCriteriaServiceOptions {
  readonly workspaceDir?: string;
  readonly timeoutMs?: number;
}

export const ICompletionCriteriaService = createDecorator<ICompletionCriteriaService>(
  'completionCriteriaService',
);

export interface ICompletionCriteriaService {
  readonly _serviceBrand: undefined;
  criteriaFor(goalId: string): Promise<readonly Criterion[]>;
  evidenceFor(goalId: string): Promise<readonly Evidence[]>;
  factsFor(goalId: string): Readonly<Record<string, number>>;
  recordEvidence(goalId: string, evidence: Evidence): void;
  recordFact(goalId: string, key: string, value: number): void;
}

interface CriteriaDocument {
  readonly criteria?: {
    readonly id: string;
    readonly description: string;
    readonly check?: Criterion extends { check: infer C } ? C : never;
    readonly undecidable?: true;
    readonly reason?: string;
  }[];
}

export class CompletionCriteriaService implements ICompletionCriteriaService {
  declare readonly _serviceBrand: undefined;

  private readonly _facts = new Map<string, Map<string, number>>();
  private readonly _evidence = new Map<string, Evidence[]>();

  constructor(private readonly _options: CompletionCriteriaServiceOptions = {}) {}

  async criteriaFor(goalId: string): Promise<readonly Criterion[]> {
    let document: CriteriaDocument;
    try {
      document = JSON.parse(
        await readFile(this._pathFor(goalId), 'utf8'),
      ) as CriteriaDocument;
    } catch {
      return [];
    }
    const declared = document.criteria ?? [];
    return declared.map((entry) => {
      if (entry.undecidable === true || entry.check === undefined) {
        return {
          id: entry.id,
          description: entry.description,
          undecidable: true as const,
          reason: entry.reason ?? 'no machine-checkable criterion was declared',
        };
      }
      return { id: entry.id, description: entry.description, check: entry.check };
    });
  }

  async evidenceFor(goalId: string): Promise<readonly Evidence[]> {
    return this._evidence.get(goalId) ?? [];
  }

  factsFor(goalId: string): Readonly<Record<string, number>> {
    return Object.fromEntries(this._facts.get(goalId) ?? new Map());
  }

  recordEvidence(goalId: string, evidence: Evidence): void {
    const list = this._evidence.get(goalId) ?? [];
    list.push(evidence);
    this._evidence.set(goalId, list);
  }

  recordFact(goalId: string, key: string, value: number): void {
    const facts = this._facts.get(goalId) ?? new Map<string, number>();
    facts.set(key, value);
    this._facts.set(goalId, facts);
  }

  private _pathFor(goalId: string): string {
    const root = this._options.workspaceDir;
    return root === undefined
      ? join('.kimi', 'goals', goalId, 'criteria.json')
      : join(root, '.kimi', 'goals', goalId, 'criteria.json');
  }
}
