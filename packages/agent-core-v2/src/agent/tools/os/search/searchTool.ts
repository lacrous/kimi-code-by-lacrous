import { IFlagService } from '#/app/flag/flag';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import {
  ISessionSearchService,
  type SessionSearchHit,
  type SessionSearchPage,
} from '#/features/sessionSearch/sessionSearch';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern } from '#/tool/rule-match';
import {
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { SESSION_SEARCH_FLAG_ID } from './flag';
import {
  DEFAULT_PAGE_SIZE,
  ISearchSessionsTool,
  SearchSessionsInputSchema,
  type SearchSessionsInput,
} from './search';
import SEARCH_DESCRIPTION from './search.md?raw';

const SEARCH_DISABLED =
  'SearchSessions is disabled. Enable the session_search experimental flag to use it.';
const SEARCH_UNAVAILABLE =
  'Session search is not available on this runtime. It requires the Kimi Code server, which owns the transcript index.';

export class SearchSessionsTool implements ISearchSessionsTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'SearchSessions' as const;
  readonly description = SEARCH_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SearchSessionsInputSchema);

  constructor(
    @IFlagService private readonly flags: IFlagService,
    @ISessionSearchService private readonly search: ISessionSearchService,
  ) {}

  resolveExecution(args: SearchSessionsInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: `Searching past sessions for "${args.query}"`,
      display: {
        kind: 'generic',
        summary: `Search past sessions for "${args.query}"`,
        detail: args.role === undefined ? undefined : `${args.role} messages only`,
      },
      approvalRule: literalRulePattern(this.name, args.query),
      execute: async () => {
        if (!this.flags.enabled(SESSION_SEARCH_FLAG_ID)) {
          return { isError: true, output: SEARCH_DISABLED };
        }
        try {
          return await this.run(args);
        } catch (error) {
          return { isError: true, output: `Session search failed: ${errorMessage(error)}` };
        }
      },
    };
  }

  private async run(args: SearchSessionsInput): Promise<ExecutableToolResult> {
    const page = await this.search.search({
      query: args.query,
      role: args.role,
      sessionId: args.session_id,
      mode: args.mode,
      sort: args.sort,
      pageSize: args.page_size ?? DEFAULT_PAGE_SIZE,
      pageToken: args.page_token,
    });
    if (page.items.length === 0) {
      return { output: renderEmpty(page) };
    }
    const lines = [`${String(page.items.length)} match(es) for "${args.query}":`];
    for (const hit of page.items) lines.push(renderHit(hit));
    if (page.hasMore === true) {
      lines.push(
        `More results are available. Pass page_token: "${String(page.pageToken ?? '')}" for the next page.`,
      );
    }
    if (page.incomplete !== undefined) {
      lines.push(`Results were truncated (${page.incomplete}). Narrow the query to see everything.`);
    }
    return { output: lines.join('\n') };
  }
}

registerAgentToolService(ISearchSessionsTool, SearchSessionsTool, {
  name: 'SearchSessions',
  domain: 'os/backends',
  when: (accessor) => accessor.get(IFlagService).enabled(SESSION_SEARCH_FLAG_ID),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderEmpty(page: SessionSearchPage): string {
  const state = page.indexState;
  if (state.state === 'building') {
    return 'The session index is still building. No matches yet — retry in a moment.';
  }
  if (state.state === 'unavailable') {
    return `${SEARCH_UNAVAILABLE}${state.degraded === undefined ? '' : ` (${state.degraded})`}`;
  }
  return `No past session matches this query. The index covers ${String(state.indexedSessions)} of ${String(state.totalSessions)} sessions.`;
}

function renderHit(hit: SessionSearchHit): string {
  const when = new Date(hit.time).toISOString().slice(0, 16).replace('T', ' ');
  const title = hit.sessionTitle.length === 0 ? '(untitled)' : hit.sessionTitle;
  const where = hit.turn === undefined ? '' : ` turn ${String(hit.turn)}`;
  return `  [${hit.role}] ${title} (session ${hit.sessionId}${where}, ${when})\n    ${hit.snippet}`;
}