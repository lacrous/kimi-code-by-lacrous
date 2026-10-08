import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const SESSION_SEARCH_FLAG_ID = 'session_search';
export const SESSION_SEARCH_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SESSION_SEARCH';

export const sessionSearchFlag: FlagDefinitionInput = {
  id: SESSION_SEARCH_FLAG_ID,
  title: 'Search past sessions',
  description:
    'Add a SearchSessions tool that finds earlier turns across this machine’s sessions, so the agent can recall what was already discussed instead of only reading the current transcript.',
  env: SESSION_SEARCH_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(sessionSearchFlag);