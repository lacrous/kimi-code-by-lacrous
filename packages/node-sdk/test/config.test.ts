import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createKimiConfigRpc } from '#/index';
import { parseConfigString } from '#/config/index';

const toPosix = (p: string): string => p.replaceAll('\\', '/');

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-config-'));
  tempDirs.push(dir);
  return dir;
}

describe('SDK config TOML', () => {
  it('resolves config paths through the config RPC wrapper', async () => {
    const dir = await makeTempDir();
    const rpc = createKimiConfigRpc();

    await expect(rpc.resolveConfigPath({ homeDir: dir })).resolves.toBe(toPosix(join(dir, 'config.toml')));
  });

  it('returns structured validation issues through the config RPC wrapper', async () => {
    const rpc = createKimiConfigRpc();

    await expect(
      rpc.validateConfigToml({
        text: `
[providers.kimi]
type = "kimi"

[models.kimi]
provider = "kimi"
model = "kimi"
max_context_size = "large"
`,
        filePath: 'broken.toml',
      }),
    ).rejects.toMatchObject({
      details: {
        validationIssues: [
          {
            path: ['models', 'kimi', 'maxContextSize'],
          },
        ],
      },
    });
  });

  it('parses a provider api_key_env into camelCase apiKeyEnv', async () => {
    const rpc = createKimiConfigRpc();
    const text = `
[providers.acme]
type = "openai"
api_key_env = "ACME_API_KEY"
`;

    await expect(rpc.validateConfigToml({ text })).resolves.toBeUndefined();
    expect(parseConfigString(text).providers['acme']?.apiKeyEnv).toBe('ACME_API_KEY');
  });

  it('keeps a provider per-model wire override through config parsing', async () => {
    // The SDK schema is a narrower mirror of the engine's; while it lacked
    // this field the pin was dropped on the way in, so a gateway's
    // cross-protocol models silently reverted to the provider's own wire.
    const rpc = createKimiConfigRpc();
    const text = `
[providers.zen]
type = "openai"
base_url = "https://zen.example.test/v1"

[providers.zen.protocolOverrides]
"claude-*" = "anthropic"

[models."zen/claude-sonnet-4"]
provider = "zen"
model = "claude-sonnet-4"
max_context_size = 200000
protocol = "anthropic"
`;

    await expect(rpc.validateConfigToml({ text })).resolves.toBeUndefined();
    expect(parseConfigString(text).providers['zen']?.protocolOverrides).toEqual({
      'claude-*': 'anthropic',
    });
    expect(parseConfigString(text).models?.['zen/claude-sonnet-4']?.protocol).toBe('anthropic');
  });

  it('accepts every wire the engine allows on an alias protocol', async () => {
    const rpc = createKimiConfigRpc();
    for (const wire of ['anthropic', 'openai', 'openai_responses', 'google-genai']) {
      const text = `
[providers.gw]
type = "openai"

[models.m]
provider = "gw"
model = "m"
max_context_size = 1000
protocol = "${wire}"
`;
      await expect(rpc.validateConfigToml({ text }), wire).resolves.toBeUndefined();
    }
  });
});
