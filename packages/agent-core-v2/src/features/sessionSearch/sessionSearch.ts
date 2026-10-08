import { createDecorator } from '#/_base/di/instantiation';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';

export type SessionSearchRole = 'user' | 'assistant' | 'title';

export interface SessionSearchQuery {
  readonly query: string;
  readonly role?: SessionSearchRole;
  readonly sessionId?: string;
  readonly mode?: 'terms' | 'literal';
  readonly sort?: 'score' | 'time_desc' | 'time_asc';
  readonly pageSize?: number;
  readonly pageToken?: string;
}

export interface SessionSearchHit {
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly agentId: string;
  readonly role: SessionSearchRole;
  readonly snippet: string;
  readonly time: number;
  readonly turn?: number;
  readonly score: number;
}

export interface SessionSearchIndexState {
  readonly state: 'building' | 'ready' | 'readonly' | 'unavailable';
  readonly indexedSessions: number;
  readonly totalSessions: number;
  readonly documents: number;
  readonly degraded?: string;
}

export interface SessionSearchPage {
  readonly items: readonly SessionSearchHit[];
  readonly hasMore: boolean;
  readonly pageToken?: string;
  readonly incomplete?: 'candidate_cap' | 'postings_budget' | 'deadline';
  readonly indexState: SessionSearchIndexState;
}

export interface ISessionSearchService {
  readonly _serviceBrand: undefined;
  search(query: SessionSearchQuery): Promise<SessionSearchPage>;
}

export const ISessionSearchService = createDecorator<ISessionSearchService>('sessionSearchService');

export const SESSION_SEARCH_UNAVAILABLE_REASON =
  'no transcript index on this runtime; session search requires the Kimi Code server';

class UnavailableSessionSearchService implements ISessionSearchService {
  declare readonly _serviceBrand: undefined;

  search(_query: SessionSearchQuery): Promise<SessionSearchPage> {
    return Promise.resolve({
      items: [],
      hasMore: false,
      indexState: {
        state: 'unavailable',
        indexedSessions: 0,
        totalSessions: 0,
        documents: 0,
        degraded: SESSION_SEARCH_UNAVAILABLE_REASON,
      },
    });
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionSearchService,
  UnavailableSessionSearchService,
  ScopeActivation.OnDemand,
  'sessionSearch',
);