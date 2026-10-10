import { explainProviderEndpoint } from '@moonshot-ai/agent-core-v2/llm-adapter/provider/provider-definition';

/**
 * The vendor fallbacks a wire type resolves when a provider record declares no
 * credential of its own.
 *
 * Only the variable *names* are surfaced, never the values they currently hold:
 * `explainProviderEndpoint` reads the environment to find out which candidate
 * is set, so passing its result straight through a CLI would put the key on
 * stdout. A caller that needs the key itself already has a credential path —
 * this exists to explain where one *would* come from.
 */
export interface ProviderEndpointEnvNames {
  /** Vendor environment variable the wire type falls back to for an API key. */
  readonly apiKeyEnvName?: string;
  /** Vendor environment variable the wire type falls back to for a base URL. */
  readonly baseUrlEnvName?: string;
  /** The wire type ships a default base URL, so no `base_url` is needed. */
  readonly baseUrlIsDefault?: boolean;
}

/**
 * Reports which vendor environment variables a wire type would fall back to
 * when the provider record is silent, so credential tooling can say "unset —
 * the wire falls back to $OPENAI_API_KEY" instead of a bare "missing" for a
 * provider that in fact works.
 */
export function providerEndpointEnvNames(
  providerType: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProviderEndpointEnvNames {
  const { apiKeyEnvName, baseUrlEnvName, baseUrlIsDefault } = explainProviderEndpoint(providerType, env);
  return {
    apiKeyEnvName,
    baseUrlEnvName,
    baseUrlIsDefault,
  };
}