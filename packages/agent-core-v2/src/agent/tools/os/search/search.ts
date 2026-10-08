import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const SearchSessionsInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'Text to look for across past sessions. Matched against what the user said, what the agent replied, and session titles.',
    ),
  role: z
    .enum(['user', 'assistant', 'title'])
    .optional()
    .describe('Restrict hits to one kind of text. Defaults to all three.'),
  session_id: z
    .string()
    .min(1)
    .optional()
    .describe('Restrict the search to a single session. Defaults to every session on this machine.'),
  mode: z
    .enum(['terms', 'literal'])
    .optional()
    .describe(
      '"terms" matches any word of the query, ranked by relevance — the default. "literal" matches the exact phrase, which is what you want for an error string, a path, or an identifier.',
    ),
  sort: z
    .enum(['score', 'time_desc', 'time_asc'])
    .optional()
    .describe('Rank by relevance (default), newest first, or oldest first.'),
  page_size: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe('Maximum number of hits to return. Defaults to 10, capped at 50.'),
  page_token: z
    .string()
    .min(1)
    .optional()
    .describe('Continuation token from a previous call whose page reported more results.'),
});

export type SearchSessionsInput = z.infer<typeof SearchSessionsInputSchema>;

export const DEFAULT_PAGE_SIZE = 10;

export interface ISearchSessionsTool extends AgentTool<SearchSessionsInput> {
  readonly _serviceBrand: undefined;
}
export const ISearchSessionsTool = createDecorator<ISearchSessionsTool>('searchSessionsTool');