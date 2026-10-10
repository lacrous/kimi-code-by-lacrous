/**
 * In-memory stand-in for the `KimiHarness` config surface.
 *
 * The merge semantics here are load-bearing, not decoration, so the whole file
 * exists to keep them honest:
 *
 * - `setConfig` mirrors `setKimiConfig`: undefined values are skipped and
 *   everything else is *deep-merged* (agent-core-v2 `app/config/configPure.ts`),
 *   recursing into each provider record. A key absent from the patch therefore
 *   survives on disk. A fake that shallow-assigned whole sections would let a
 *   test pass no matter what the command wrote, because the stale field would
 *   never have been merged back — and a command that clears `apiKeyEnv` would
 *   report success on a record the runtime then rejects for carrying two
 *   credential fields at once.
 * - `replaceConfigSections` mirrors `configService.replaceSections`: each named
 *   section is replaced wholesale, `undefined` clears it, and a section that is
 *   not named is left alone. This is the only write that can express a deletion.
 *
 * Every test fake that stands in for the harness must come from here; a local
 * copy is how the two drift apart.
 */

import type { KimiConfig } from '@moonshot-ai/kimi-code-sdk';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch ?? base;
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(patch)) {
    const pv = patch[key];
    out[key] = isPlainObject(out[key]) && isPlainObject(pv) ? deepMerge(out[key], pv) : pv;
  }
  return out;
}

export interface ConfigStoreHarness {
  ensureConfigFile: () => Promise<void>;
  getConfig: () => Promise<KimiConfig>;
  setConfig: (patch: Partial<KimiConfig>) => Promise<KimiConfig>;
  replaceConfigSections: (sections: Record<string, unknown>) => Promise<void>;
  removeProvider: (providerId: string) => Promise<KimiConfig>;
  close: () => Promise<void>;
}

export interface ConfigStore {
  readonly harness: ConfigStoreHarness;
  /** The store as it stands now — i.e. what the next `getConfig` would read. */
  current: () => KimiConfig;
  readonly setConfigCalls: Array<Partial<KimiConfig>>;
  readonly replaceCalls: Array<Record<string, unknown>>;
  readonly removeCalls: string[];
}

/**
 * Builds a harness over `initial`. `persisted` stands in for the on-disk
 * config: the real RPC reads and writes disk on every call, so anything a
 * handler builds up in its own in-memory `config` object is gone unless a write
 * landed before the next `removeProvider`.
 */
export function makeConfigStoreHarness(initial: KimiConfig): ConfigStore {
  let persisted: KimiConfig = structuredClone(initial);
  const setConfigCalls: Array<Partial<KimiConfig>> = [];
  const replaceCalls: Array<Record<string, unknown>> = [];
  const removeCalls: string[] = [];
  const harness: ConfigStoreHarness = {
    ensureConfigFile: async () => {},
    getConfig: async () => structuredClone(persisted),
    setConfig: async (patch) => {
      setConfigCalls.push(structuredClone(patch));
      const next: Record<string, unknown> = { ...persisted };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        next[key] = deepMerge(next[key], value);
      }
      persisted = next as KimiConfig;
      return structuredClone(persisted);
    },
    replaceConfigSections: async (sections) => {
      replaceCalls.push(structuredClone(sections));
      const next: Record<string, unknown> = { ...persisted };
      for (const [key, value] of Object.entries(sections)) {
        if (value === undefined) {
          delete next[key];
          continue;
        }
        next[key] = value;
      }
      persisted = next as KimiConfig;
    },
    removeProvider: async (providerId) => {
      removeCalls.push(providerId);
      const nextProviders = { ...persisted.providers };
      delete nextProviders[providerId];
      const nextModels = { ...persisted.models };
      let removedDefault = false;
      for (const [alias, model] of Object.entries(nextModels)) {
        if (model.provider === providerId) {
          delete nextModels[alias];
          if (persisted.defaultModel === alias) removedDefault = true;
        }
      }
      persisted = { ...persisted, providers: nextProviders, models: nextModels };
      if (removedDefault) persisted = { ...persisted, defaultModel: undefined };
      return structuredClone(persisted);
    },
    close: async () => {},
  };
  return { harness, current: () => persisted, setConfigCalls, replaceCalls, removeCalls };
}