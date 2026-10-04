/**
 * Built-in provider shortcuts: vendors whose protocol and endpoint are fixed,
 * configurable without consulting the models.dev catalog.
 *
 * Shared by the CLI (`kimi provider add-builtin`) and the TUI `/provider`
 * menu. Kept at app level (`src/utils`, not `src/tui/utils`) because neither
 * surface owns it — it is pure data with no TUI-state dependency.
 *
 * Model ids and limits are never stored here: they are always read from the
 * endpoint's `/models` route, so a built-in tracks the vendor's current
 * catalog. This is the offline path and the discoverable label, not a second
 * source of truth.
 *
 * Caveat worth knowing: `/models` returns ids and little else, and cannot
 * express a per-model protocol. Some gateways (OpenCode Zen) serve part of
 * their catalog over the Anthropic Messages API and mark those models in
 * models.dev, but that metadata is not visible here. Those models are
 * therefore listed and may fail on first use; import the vendor from the
 * models.dev catalog instead if you need the per-model protocol honored.
 */

export interface BuiltInProvider {
  /** Provider id written into config.toml. */
  readonly id: string;
  /** Display name shown in menus. */
  readonly name: string;
  /**
   * Wire protocol, narrowed to the `ProviderConfig['type']` union so a built-in
   * can be written into config without a cast.
   */
  readonly wire: 'anthropic' | 'openai' | 'kimi' | 'google-genai' | 'openai_responses' | 'vertexai';
  /** OpenAI-compatible base URL, including any `/v1` segment. */
  readonly baseUrl: string;
  /** Subtitle shown under the name in the picker. */
  readonly description: string;
  /** Where the user obtains a key, shown in the API-key prompt. */
  readonly consoleUrl: string;
  /**
   * Expected key prefix, used only as a hint in the API-key prompt. Advisory
   * rather than enforced — vendors change prefixes without notice, and
   * rejecting a valid key would be worse than a missing hint.
   */
  readonly keyHint?: string;
}

export const BUILT_IN_PROVIDERS: readonly BuiltInProvider[] = [
  {
    id: 'cline',
    name: 'Cline',
    wire: 'openai',
    baseUrl: 'https://api.cline.bot/api/v1',
    description: 'One key for Anthropic, OpenAI, Google and more',
    consoleUrl: 'https://app.cline.bot',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    wire: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    description: 'One key for 400+ models across many providers',
    consoleUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    wire: 'openai',
    baseUrl: 'https://opencode.ai/zen/v1',
    description: 'Curated models tested by the OpenCode team',
    consoleUrl: 'https://opencode.ai/zen',
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    wire: 'openai',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    description: 'OpenCode Zen models on the Go plan',
    consoleUrl: 'https://opencode.ai/zen',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA',
    wire: 'openai',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    description: 'NVIDIA-hosted open models, free developer tier',
    consoleUrl: 'https://build.nvidia.com',
    keyHint: 'nvapi-',
  },
  {
    id: 'nara',
    name: 'NaraRouter',
    wire: 'openai',
    baseUrl: 'https://router.bynara.id/v1',
    description: 'Affordable multi-model gateway',
    consoleUrl: 'https://router.bynara.id',
    keyHint: 'sk-nry-',
  },
  {
    id: 'tokenharbor',
    name: 'Token Harbor',
    wire: 'openai',
    baseUrl: 'https://tokenharbor.ai/v1',
    description: 'One universal key for many AI providers',
    consoleUrl: 'https://tokenharbor.ai/dashboard/api-keys',
    keyHint: 'thk_live_',
  },
];

export function getBuiltInProvider(id: string): BuiltInProvider | undefined {
  const needle = id.trim().toLowerCase();
  return BUILT_IN_PROVIDERS.find((p) => p.id === needle);
}