import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

let home: string;
let server: RunningServer | undefined;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'kimi-server-v2-file-history-'));
  server = await startServer({
    hostIdentity: TEST_HOST_IDENTITY,
    host: '127.0.0.1',
    port: 0,
    homeDir: home,
    logLevel: 'silent',
  });
});

afterAll(async () => {
  try {
    await server?.close();
  } catch {
  }
  server = undefined;
  rmSync(home, { recursive: true, force: true });
});

async function boot(): Promise<RunningServer> {
  return server as RunningServer;
}

interface InjectResponse {
  statusCode: number;
  body: string;
  json: () => unknown;
}

interface AppLike {
  inject: (req: unknown) => Promise<InjectResponse>;
}

function appOf(r: RunningServer): AppLike {
  const app = r.app as unknown as AppLike;
  return {
    inject(req: unknown): Promise<InjectResponse> {
      const request = req as { headers?: Record<string, string> };
      return app.inject({
        ...request,
        headers: {
          ...request.headers,
          authorization: `Bearer ${r.authTokenService.getToken()}`,
        },
      });
    },
  };
}

interface Envelope<T = unknown> {
  code: number;
  msg: string;
  data: T | null;
}

async function createSession(r: RunningServer): Promise<string> {
  const res = await appOf(r).inject({
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { metadata: { cwd: home } },
    headers: { 'content-type': 'application/json' },
  });
  const envelope = res.json() as Envelope<{ id: string }>;
  if (envelope.code !== 0 || envelope.data === null) {
    throw new Error(`failed to create session: ${res.body}`);
  }
  return envelope.data.id;
}

describe('file history routes', () => {
  it('serves empty changes and null content for a live session without history', async () => {
    const r = await boot();
    const sessionId = await createSession(r);

    const changes = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/file-history/changes?turn_id=1`,
    });
    expect(changes.statusCode).toBe(200);
    expect((changes.json() as Envelope<{ changes: unknown[] }>).data).toEqual({
      changes: [],
      recorded: false,
    });

    const content = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/file-history/content?turn_id=1&path=a.txt`,
    });
    expect(content.statusCode).toBe(200);
    expect((content.json() as Envelope<{ content: unknown }>).data).toEqual({ content: null });
  });

  it('rejects a session that is not live', async () => {
    const r = await boot();
    const res = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/sessions/does-not-exist/file-history/changes?turn_id=1',
    });
    const envelope = res.json() as Envelope;
    expect(envelope.code).not.toBe(0);
    expect(envelope.data).toBeNull();
  });

  it('rejects a malformed turn_id', async () => {
    const r = await boot();
    const sessionId = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/file-history/changes?turn_id=abc`,
    });
    const envelope = res.json() as Envelope;
    expect(envelope.code).not.toBe(0);
  });
});

const FILE_RESTORE_ENV = 'KIMI_CODE_EXPERIMENTAL_FILE_RESTORE';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('file history turn listing and restore', () => {
  it('refuses both actions while the file_restore flag is off', async () => {
    vi.stubEnv(FILE_RESTORE_ENV, undefined);
    const r = await boot();
    const sessionId = await createSession(r);

    const turns = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/file-history/turns`,
    });
    const turnsEnvelope = turns.json() as Envelope;
    expect(turnsEnvelope.code).toBe(40925);
    expect(turnsEnvelope.data).toBeNull();
    expect(turnsEnvelope.msg).toContain(FILE_RESTORE_ENV);

    const restore = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/file-history/restore`,
      payload: { turn_id: 1 },
      headers: { 'content-type': 'application/json' },
    });
    const restoreEnvelope = restore.json() as Envelope;
    expect(restoreEnvelope.code).toBe(40925);
    expect(restoreEnvelope.data).toBeNull();
    expect(restoreEnvelope.msg).toContain(FILE_RESTORE_ENV);
  });

  it('reports an empty turn list for a live session without history', async () => {
    vi.stubEnv(FILE_RESTORE_ENV, '1');
    const r = await boot();
    const sessionId = await createSession(r);

    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/file-history/turns`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Envelope<{ turns: unknown[] }>).data).toEqual({ turns: [] });
  });

  it('marks every requested file unavailable when the turn has no history', async () => {
    vi.stubEnv(FILE_RESTORE_ENV, '1');
    const r = await boot();
    const sessionId = await createSession(r);

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/file-history/restore`,
      payload: { turn_id: 1, paths: ['a.txt', 'b.txt'] },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Envelope<{ turnId: number; files: unknown[] }>).data).toEqual({
      turnId: 1,
      files: [
        { path: 'a.txt', state: 'unavailable', detail: 'turn 1 has no recorded file history' },
        { path: 'b.txt', state: 'unavailable', detail: 'turn 1 has no recorded file history' },
      ],
    });
  });

  it('rejects a session that is not live before checking the flag', async () => {
    vi.stubEnv(FILE_RESTORE_ENV, '1');
    const r = await boot();

    const turns = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/sessions/does-not-exist/file-history/turns',
    });
    expect((turns.json() as Envelope).code).toBe(40401);

    const restore = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions/does-not-exist/file-history/restore',
      payload: { turn_id: 1 },
      headers: { 'content-type': 'application/json' },
    });
    expect((restore.json() as Envelope).code).toBe(40401);
  });
});
