import { describe, expect, it, vi } from 'vitest';

import { IFlagService } from '#/app/flag/flag';
import {
  ISessionSearchService,
  type SessionSearchPage,
  type SessionSearchQuery,
} from '#/features/sessionSearch/sessionSearch';
import { SearchSessionsTool } from '#/agent/tools/os/search/searchTool';
import { SESSION_SEARCH_FLAG_ID } from '#/agent/tools/os/search/flag';
import type { ExecutableToolContext } from '#/tool/toolContract';

const CTX = { signal: new AbortController().signal } as ExecutableToolContext;

function page(overrides: Partial<SessionSearchPage> = {}): SessionSearchPage {
  return {
    items: [],
    hasMore: false,
    indexState: {
      state: 'ready',
      indexedSessions: 3,
      totalSessions: 3,
      documents: 42,
    },
    ...overrides,
  };
}

function unavailablePage(): SessionSearchPage {
  return {
    items: [],
    hasMore: false,
    indexState: {
      state: 'unavailable',
      indexedSessions: 0,
      totalSessions: 0,
      documents: 0,
      degraded: 'no transcript index on this runtime',
    },
  };
}

function makeTool(options: { enabled?: boolean; search?: ISessionSearchService } = {}) {
  const flags = { enabled: vi.fn((id: string) => (id === SESSION_SEARCH_FLAG_ID ? (options.enabled ?? true) : false)) };
  const search = options.search ?? { search: vi.fn(async () => unavailablePage()) };
  const tool = new SearchSessionsTool(
    flags as unknown as IFlagService,
    search as ISessionSearchService,
  );
  return { tool, flags };
}

async function run(
  tool: SearchSessionsTool,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; output: string }> {
  const execution = tool.resolveExecution(args as never);
  if ('isError' in execution && execution.isError === true) {
    throw new Error('resolveExecution returned an error');
  }
  return (await execution.execute(CTX)) as { isError?: boolean; output: string };
}

describe('SearchSessionsTool', () => {
  it('refuses to run while the session_search flag is off', async () => {
    const { tool } = makeTool({ enabled: false });

    const result = await run(tool, { query: 'refactor' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('session_search experimental flag');
  });

  it('explains the missing binding instead of failing opaquely', async () => {
    const { tool } = makeTool({ enabled: true });

    const result = await run(tool, { query: 'refactor' });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('not available on this runtime');
  });

  it('defaults the page size and forwards the narrowing arguments', async () => {
    const search = { search: vi.fn(async () => page()) } as unknown as ISessionSearchService;
    const { tool } = makeTool({ search });

    await run(tool, { query: 'retry backoff', role: 'user', session_id: 's1', mode: 'literal' });

    expect(search.search).toHaveBeenCalledWith({
      query: 'retry backoff',
      role: 'user',
      sessionId: 's1',
      mode: 'literal',
      sort: undefined,
      pageSize: 10,
      pageToken: undefined,
    });
  });

  it('renders hits with their session, turn and snippet', async () => {
    const search = {
      search: vi.fn(async () =>
        page({
          items: [
            {
              sessionId: 's1',
              sessionTitle: 'Retry work',
              agentId: 'main',
              role: 'user' as const,
              snippet: 'the backoff should be exponential',
              time: Date.UTC(2026, 0, 2, 3, 4),
              turn: 7,
              score: 1.5,
            },
          ],
        }),
      ),
    } as unknown as ISessionSearchService;
    const { tool } = makeTool({ search });

    const result = await run(tool, { query: 'backoff' });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('1 match(es) for "backoff"');
    expect(result.output).toContain('[user] Retry work (session s1 turn 7, 2026-01-02 03:04)');
    expect(result.output).toContain('the backoff should be exponential');
  });

  it('offers a continuation token when more hits remain', async () => {
    const search = {
      search: vi.fn(async () =>
        page({
          hasMore: true,
          pageToken: 'tok-2',
          items: [
            {
              sessionId: 's1',
              sessionTitle: 'T',
              agentId: 'main',
              role: 'title' as const,
              snippet: 'Retry work',
              time: Date.UTC(2026, 0, 2),
              score: 1,
            },
          ],
        }),
      ),
    } as unknown as ISessionSearchService;
    const { tool } = makeTool({ search });

    const result = await run(tool, { query: 'retry' });

    expect(result.output).toContain('page_token: "tok-2"');
  });

  it('tells the caller to wait when the index is still building', async () => {
    const search = {
      search: vi.fn(async () =>
        page({
          indexState: { state: 'building', indexedSessions: 1, totalSessions: 9, documents: 3 },
        }),
      ),
    } as unknown as ISessionSearchService;
    const { tool } = makeTool({ search });

    const result = await run(tool, { query: 'retry' });

    expect(result.output).toContain('index is still building');
  });

  it('reports an empty result against a ready index', async () => {
    const search = { search: vi.fn(async () => page()) } as unknown as ISessionSearchService;
    const { tool } = makeTool({ search });

    const result = await run(tool, { query: 'nothing here' });

    expect(result.output).toContain('No past session matches');
    expect(result.output).toContain('covers 3 of 3 sessions');
  });

  it('surfaces a backend failure as a tool error', async () => {
    const search = {
      search: vi.fn(async (_query: SessionSearchQuery) => {
        throw new Error('index unreadable');
      }),
    } as unknown as ISessionSearchService;
    const { tool } = makeTool({ search });

    const result = await run(tool, { query: 'retry' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('index unreadable');
  });
});