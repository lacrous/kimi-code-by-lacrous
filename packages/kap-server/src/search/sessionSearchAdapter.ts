import {
  ISessionSearchService,
  LifecycleScope,
  overrideScopedService,
  ScopeActivation,
  type SessionSearchPage,
  type SessionSearchQuery,
} from '@moonshot-ai/agent-core-v2';

import { IGlobalSearchService } from './searchService';

export class SessionSearchAdapter implements ISessionSearchService {
  declare readonly _serviceBrand: undefined;

  constructor(@IGlobalSearchService private readonly global: IGlobalSearchService) {}

  async search(query: SessionSearchQuery): Promise<SessionSearchPage> {
    const page = await this.global.search({
      query: query.query,
      role: query.role,
      mode: query.mode,
      sort: query.sort,
      pageSize: query.pageSize,
      pageToken: query.pageToken,
      container: query.sessionId === undefined ? undefined : { sessionId: query.sessionId },
    });
    return {
      items: page.items.map((hit) => ({
        sessionId: hit.sessionId,
        sessionTitle: hit.sessionTitle,
        agentId: hit.agentId,
        role: hit.role,
        snippet: hit.snippet,
        time: hit.time,
        score: hit.score,
        turn: hit.turn,
      })),
      hasMore: page.hasMore,
      pageToken: page.pageToken,
      incomplete: page.incomplete,
      indexState: {
        state: page.indexState.state,
        indexedSessions: page.indexState.indexedSessions,
        totalSessions: page.indexState.totalSessions,
        documents: page.indexState.documents,
        degraded: page.indexState.degraded,
      },
    };
  }
}

overrideScopedService(
  LifecycleScope.App,
  ISessionSearchService,
  SessionSearchAdapter,
  ScopeActivation.OnDemand,
  'sessionSearch',
);