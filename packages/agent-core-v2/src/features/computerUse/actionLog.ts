import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ActionRecord } from '#/features/computerUse/observation';

export interface ActionLogEntry {
  readonly at: number;
  readonly action: string;
  readonly arguments: Record<string, unknown>;
  readonly durationMs: number;
  readonly success: boolean;
  readonly failureClass: string | undefined;
  readonly error: string | undefined;
  readonly screenshotRef: string | undefined;
  readonly goalId: string | undefined;
  readonly taskId: string | undefined;
}

export interface ActionLogQuery {
  readonly goalId?: string;
  readonly taskId?: string;
  readonly limit?: number;
}

export class ActionLog {
  private readonly _path: string;

  constructor(path: string) {
    this._path = path;
  }

  get path(): string {
    return this._path;
  }

  async append(entry: ActionLogEntry): Promise<void> {
    await mkdir(dirname(this._path), { recursive: true });
    await appendFile(this._path, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  record(
    record: ActionRecord,
    context: { goalId?: string; taskId?: string; screenshotRef?: string } = {},
  ): ActionLogEntry {
    return {
      at: record.startedAt,
      action: record.action,
      arguments: record.arguments,
      durationMs: record.durationMs,
      success: record.success,
      failureClass: record.failureClass,
      error: record.error,
      screenshotRef: context.screenshotRef,
      goalId: context.goalId,
      taskId: context.taskId,
    };
  }

  async read(query: ActionLogQuery = {}): Promise<ActionLogEntry[]> {
    let text: string;
    try {
      text = await readFile(this._path, 'utf8');
    } catch {
      return [];
    }
    const entries: ActionLogEntry[] = [];
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      let parsed: ActionLogEntry;
      try {
        parsed = JSON.parse(line) as ActionLogEntry;
      } catch {
        continue;
      }
      if (query.goalId !== undefined && parsed.goalId !== query.goalId) continue;
      if (query.taskId !== undefined && parsed.taskId !== query.taskId) continue;
      entries.push(parsed);
    }
    return query.limit === undefined ? entries : entries.slice(-query.limit);
  }

  async count(query: ActionLogQuery = {}): Promise<number> {
    return (await this.read(query)).length;
  }

  async failures(): Promise<ActionLogEntry[]> {
    return (await this.read()).filter((entry) => !entry.success);
  }

  async format(query: ActionLogQuery = {}): Promise<string> {
    const entries = await this.read(query);
    if (entries.length === 0) {
      return 'No actions recorded.';
    }
    return entries
      .map((entry) => {
        const time = new Date(entry.at).toISOString().replace('T', ' ').slice(0, 19);
        const status = entry.success ? 'OK  ' : 'FAIL';
        const detail = entry.success
          ? ''
          : ` ${entry.failureClass ?? 'unknown'}${entry.error === undefined ? '' : `: ${entry.error}`}`;
        return `${time}  ${status}  ${entry.action}${detail}`;
      })
      .join('\n');
  }
}
