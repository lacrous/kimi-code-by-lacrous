/**
 * Built-in provider shortcuts: vendors whose protocol and endpoint are fixed,
 * configurable without consulting the models.dev catalog.
 *
 * Author: lacrous (fork of MoonshotAI/kimi-code).
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

/**
 * Wires a single model alias may be pinned to — the engine's `Protocol`, which
 * is `wire` minus `kimi`.
 *
 * `kimi` is a provider wire, not a `Protocol` member: a per-model pin naming
 * it could not be validated or stored, and `ProtocolSchema` drops it at the
 * config boundary. Typing the override map separately from `wire` makes that
 * unrepresentable in the first place, rather than a runtime surprise.
 */
export type BuiltInProviderPin = 'anthropic' | 'openai' | 'google-genai' | 'openai_responses';

export interface BuiltInProvider {
  /** Provider id written into config.toml. */
  readonly id: string;
  /** Display name shown in menus. */
  readonly name: string;
  /**
   * Wire protocol, narrowed to the `ProviderConfig['type']` union so a built-in
   * can be written into config without a cast.
   *
   * `vertexai` was once listed here and was a trap: it is not in
   * `MANUAL_PROVIDER_TYPES`, so `add-builtin` (which delegates to
   * `add-manual`) rejected it before writing anything, and the engine's
   * discoverable-wire set does not include it either. A built-in may only
   * declare a wire that both accept — `test/cli/provider.test.ts` enforces it.
   */
  readonly wire: 'anthropic' | 'openai' | 'kimi' | 'google-genai' | 'openai_responses';
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
  /**
   * Auth style the vendor's `/models` route expects. Defaults to Bearer, which
   * covers every OpenAI-compatible endpoint. Anthropic (`x-api-key` plus
   * `anthropic-version`) and Google (`x-goog-api-key`) are the exceptions —
   * sending them a Bearer header returns a 401 indistinguishable from a bad
   * key, so the style must be declared rather than guessed.
   */
  readonly authStyle?: 'bearer' | 'x-api-key' | 'x-goog-api-key';
  /**
   * Per-model wire pins, keyed by model id or `prefix*` glob, for vendors whose
   * `/models` route lists a model served over a protocol other than this
   * entry's `wire`.
   *
   * `/models` returns ids and little else and cannot express a per-model
   * protocol, so this table is the only place that knowledge can live. Written
   * into config as `providers.<id>.protocolOverrides`; discovery copies each
   * match onto the model alias, where it takes precedence over the provider's
   * own wire. A vendor with no overrides behaves exactly as before.
   */
  readonly protocolOverrides?: Readonly<Record<string, BuiltInProviderPin>>;
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
    // Zen serves its Claude models over the Anthropic Messages API rather
    // than the OpenAI chat route its `/models` implies. Without this pin they
    // are listed and then fail on first use, because nothing in the endpoint's
    // response says which protocol they need.
    protocolOverrides: {
      'claude-*': 'anthropic',
    },
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
  {
    id: 'openai',
    name: 'OpenAI',
    wire: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    description: 'GPT, o-series and Codex models',
    consoleUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'sk-',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    wire: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    description: 'Claude models',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'sk-ant-',
    authStyle: 'x-api-key',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    wire: 'google-genai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    description: 'Gemini models',
    consoleUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'AIza',
    authStyle: 'x-goog-api-key',
  },
  {
    id: 'grok',
    name: 'xAI Grok',
    wire: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    description: 'Grok models',
    consoleUrl: 'https://console.x.ai',
    keyHint: 'xai-',
  },
  {
    id: 'groq',
    name: 'Groq',
    wire: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    description: 'Fast open models on Groq hardware',
    consoleUrl: 'https://console.groq.com/keys',
    keyHint: 'gsk_',
  },
  {
    id: 'qwen',
    name: 'Qwen',
    wire: 'openai',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    description: 'Alibaba Qwen models',
    consoleUrl: 'https://bailian.console.alibabacloud.com/',
    keyHint: 'sk-',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    wire: 'openai',
    baseUrl: 'https://api.minimax.io/v1',
    description: 'MiniMax models',
    consoleUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    wire: 'openai',
    baseUrl: 'https://api.deepseek.com',
    description: 'DeepSeek chat and reasoning models',
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    keyHint: 'sk-',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    wire: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    description: 'Mistral and Magistral models',
    consoleUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    wire: 'openai',
    baseUrl: 'https://router.huggingface.co/v1',
    description: 'Open models via the Hugging Face router',
    consoleUrl: 'https://huggingface.co/settings/tokens',
    keyHint: 'hf_',
  },
];

export function getBuiltInProvider(id: string): BuiltInProvider | undefined {
  const needle = id.trim().toLowerCase();
  return BUILT_IN_PROVIDERS.find((p) => p.id === needle);
}