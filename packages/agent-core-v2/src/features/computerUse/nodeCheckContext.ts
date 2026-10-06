import { execFile } from 'node:child_process';
import { readFile as readFileFs, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

import type { CheckContext, Evidence } from '#/features/computerUse/goalVerifier';

const execFileAsync = promisify(execFile);

export interface NodeCheckContextOptions {
  readonly workspaceDir?: string;
  readonly timeoutMs?: number;
  readonly maxReadBytes?: number;
  readonly fetchImpl?: typeof fetch;
}

function resolveIn(workspaceDir: string | undefined, path: string): string {
  if (workspaceDir === undefined || path.startsWith('/')) return path;
  return `${workspaceDir.replace(/\/$/, '')}/${path}`;
}

export function createNodeCheckContext(
  evidence: readonly Evidence[],
  options: NodeCheckContextOptions = {},
): CheckContext {
  const timeout = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxReadBytes ?? 2 * 1024 * 1024;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    evidence,

    async fileExists(path: string): Promise<boolean> {
      try {
        const info = await stat(resolveIn(options.workspaceDir, path));
        return info.isFile() || info.isDirectory();
      } catch {
        return false;
      }
    },

    async readFile(path: string): Promise<string | undefined> {
      try {
        const info = await stat(resolveIn(options.workspaceDir, path));
        if (info.size > maxBytes) return undefined;
        return await readFileFs(resolveIn(options.workspaceDir, path), 'utf8');
      } catch {
        return undefined;
      }
    },

    async run(command: string): Promise<number> {
      try {
        await execFileAsync('/bin/sh', ['-c', command], { timeout, maxBuffer: 4 * 1024 * 1024 });
        return 0;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
        if (typeof code === 'number') return code;
        return 1;
      }
    },

    async fetchText(url: string): Promise<string | undefined> {
      try {
        const response = await doFetch(url, { signal: AbortSignal.timeout(timeout) });
        if (!response.ok) return undefined;
        const text = await response.text();
        return text.length > maxBytes ? text.slice(0, maxBytes) : text;
      } catch {
        return undefined;
      }
    },
  };
}
