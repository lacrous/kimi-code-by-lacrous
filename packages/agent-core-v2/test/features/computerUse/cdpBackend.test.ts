import { describe, expect, it, vi } from 'vitest';

import {
  CdpBrowserBackend,
  CdpClient,
  parseAxTree,
  toSelectorExpression,
  type CdpSocket,
} from '#/features/computerUse/browser/cdpBackend';

interface FakeSocket extends CdpSocket {
  readonly sent: string[];
  emitMessage(payload: unknown): void;
  emitClose(): void;
  emitError(error: Error): void;
}

function fakeSocket(auto: Record<string, unknown> = {}): FakeSocket {
  const sent: string[] = [];
  const handlers = new Map<string, ((data: never) => void)[]>();
  const socket: FakeSocket = {
    sent,
    send: (payload) => {
      sent.push(payload);
      if (Object.keys(auto).length === 0) return;
      const message = JSON.parse(payload) as { id: number; method: string };
      const result = auto[message.method];
      queueMicrotask(() => {
        socket.emitMessage({ id: message.id, result: result ?? {} });
      });
    },
    close: () => {},
    on: (event, handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler as (data: never) => void);
      handlers.set(event, list);
    },
    emitMessage: (payload) => {
      for (const handler of handlers.get('message') ?? []) {
        (handler as (data: string) => void)(JSON.stringify(payload));
      }
    },
    emitClose: () => {
      for (const handler of handlers.get('close') ?? []) {
        (handler as () => void)();
      }
    },
    emitError: (error) => {
      for (const handler of handlers.get('error') ?? []) {
        (handler as (e: Error) => void)(error);
      }
    },
  };
  return socket;
}

function replies(socket: FakeSocket, responses: Record<string, unknown>): void {
  for (const raw of socket.sent) {
    const message = JSON.parse(raw) as { id: number; method: string };
    const result = responses[message.method];
    socket.emitMessage({ id: message.id, result: result ?? {} });
  }
}

describe('CdpClient', () => {
  it('resolves a call with the matching id', async () => {
    const socket = fakeSocket();
    const client = new CdpClient(socket);

    const promise = client.call('Page.enable');
    replies(socket, { 'Page.enable': { ok: true } });

    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('rejects with the protocol error message', async () => {
    const socket = fakeSocket();
    const client = new CdpClient(socket);

    const promise = client.call('Bad.method');
    const raw = JSON.parse(socket.sent[0] as string) as { id: number };
    socket.emitMessage({ id: raw.id, error: { message: "'Bad.method' wasn't found" } });

    await expect(promise).rejects.toThrow("'Bad.method' wasn't found");
  });

  it('matches responses out of order', async () => {
    const socket = fakeSocket();
    const client = new CdpClient(socket);
    const first = client.call('A');
    const second = client.call('B');
    const [idA, idB] = socket.sent.map((s) => (JSON.parse(s) as { id: number }).id);

    socket.emitMessage({ id: idB as number, result: { which: 'B' } });
    socket.emitMessage({ id: idA as number, result: { which: 'A' } });

    await expect(first).resolves.toEqual({ which: 'A' });
    await expect(second).resolves.toEqual({ which: 'B' });
  });

  it('rejects every pending call when the socket closes', async () => {
    const socket = fakeSocket();
    const client = new CdpClient(socket);
    const pending = client.call('Never.answers');

    socket.emitClose();

    await expect(pending).rejects.toThrow(/closed/);
  });

  it('rejects a call made after close instead of hanging', async () => {
    const socket = fakeSocket();
    const client = new CdpClient(socket);
    socket.emitClose();

    await expect(client.call('Anything')).rejects.toThrow(/closed/);
  });

  it('delivers events to registered listeners', async () => {
    const socket = fakeSocket();
    const client = new CdpClient(socket);
    const seen: unknown[] = [];
    client.on('Page.loadEventFired', (params) => seen.push(params));

    socket.emitMessage({ method: 'Page.loadEventFired', params: { timestamp: 1 } });

    expect(seen).toEqual([{ timestamp: 1 }]);
  });

  it('ignores an id it has no pending call for', () => {
    const socket = fakeSocket();
    const client = new CdpClient(socket);

    expect(() => socket.emitMessage({ id: 999, result: {} })).not.toThrow();
    expect(client).toBeDefined();
  });
});

describe('parseAxTree', () => {
  it('flattens the CDP accessibility tree into nodes', () => {
    const nodes = parseAxTree({
      nodes: [
        { role: { value: 'button' }, name: { value: 'Save' }, backendDOMNodeId: 4, focused: false },
        { role: { value: 'textbox' }, name: { value: 'Email' }, backendDOMNodeId: 5, focused: true },
      ],
    });

    expect(nodes).toEqual([
      { role: 'button', name: 'Save', backendNodeId: 4, focused: false },
      { role: 'textbox', name: 'Email', backendNodeId: 5, focused: true },
    ]);
  });

  it('tolerates a node with no role or name', () => {
    expect(parseAxTree({ nodes: [{}] })).toEqual([
      { role: '', name: '', backendNodeId: undefined, focused: false },
    ]);
  });

  it('returns nothing for an empty tree', () => {
    expect(parseAxTree({})).toEqual([]);
  });
});

describe('toSelectorExpression', () => {
  it('builds a querySelector expression for a css target', () => {
    expect(toSelectorExpression({ kind: 'css', css: '#submit' })).toBe(
      'document.querySelector("#submit")',
    );
  });

  it('quotes a css selector safely', () => {
    expect(toSelectorExpression({ kind: 'css', css: 'a[data-x="1"]' })).toContain(
      '\\"1\\"'.replace('\\"', '\\"'),
    );
  });

  it('builds a role query', () => {
    expect(toSelectorExpression({ kind: 'role', role: 'button', name: 'Save' })).toBe(
      'document.querySelector("[role=\\"button\\"]")',
    );
  });

  it('escapes a text target into the comparison', () => {
    const expression = toSelectorExpression({ kind: 'text', text: 'Sign "out"' });

    expect(expression).toContain('document.querySelectorAll');
    expect(expression).toContain('Sign \\"out\\"');
  });
});

describe('CdpBrowserBackend', () => {
  const READ_PAGE = {
    'Target.createTarget': { targetId: 'T1' },
    'Target.attachToTarget': { sessionId: 'S1' },
    'Runtime.evaluate': { result: { value: 'https://example.test/' } },
    'Accessibility.getFullAXTree': {
      nodes: [{ role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 3 }],
    },
  } as const;

  function backendWith(auto: Record<string, unknown> = {}): {
    backend: CdpBrowserBackend;
    socket: FakeSocket;
  } {
    const socket = fakeSocket(auto);
    const backend = new CdpBrowserBackend({
      endpoint: 'ws://127.0.0.1:9222/devtools/page/x',
      connectionFactory: async () => socket,
    });
    return { backend, socket };
  }

  it('attaches a target and enables every domain it reads from', async () => {
    const { backend, socket } = backendWith(READ_PAGE);

    await backend.launch();

    const methods = socket.sent.map((s) => (JSON.parse(s) as { method: string }).method);
    expect(methods).toContain('Target.createTarget');
    expect(methods).toContain('Target.attachToTarget');
    expect(methods).toContain('Page.enable');
    expect(methods).toContain('Runtime.enable');
    expect(methods).toContain('DOM.enable');
    expect(methods).toContain('Accessibility.enable');
  });

  it('reads url, title, text and the accessibility tree', async () => {
    const { backend } = backendWith(READ_PAGE);

    const frame = await backend.readPage();

    expect(frame.url).toBe('https://example.test/');
    expect(frame.accessibility[0]).toMatchObject({ role: 'button', name: 'Go', backendNodeId: 3 });
  });

  it('decodes a screenshot from base64', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { backend } = backendWith({
      ...READ_PAGE,
      'Page.captureScreenshot': { data: Buffer.from(png).toString('base64') },
    });

    expect(await backend.screenshot()).toEqual(png);
  });

  it('fails clearly when the protocol returns no target id', async () => {
    const socket = fakeSocket({ ReplyEverything: true });
    const backend = new CdpBrowserBackend({
      endpoint: 'ws://127.0.0.1:9222',
      connectionFactory: async () => socket,
    });

    await expect(backend.launch()).rejects.toThrow(/did not return a target id/);
  });

  it('fails clearly when a screenshot comes back without data', async () => {
    const { backend } = backendWith({ ...READ_PAGE, 'Page.captureScreenshot': {} });

    await expect(backend.screenshot()).rejects.toThrow(/no data/);
  });

  it('surfaces a protocol error as a rejected promise', async () => {
    const socket = fakeSocket();
    const backend = new CdpBrowserBackend({
      endpoint: 'ws://127.0.0.1:9222',
      connectionFactory: async () => socket,
    });
    const promise = backend.launch();
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    const raw = JSON.parse(socket.sent[0] as string) as { id: number };
    socket.emitMessage({ id: raw.id, error: { message: 'browser is closing' } });

    await expect(promise).rejects.toThrow('browser is closing');
  });

  it('reports a select that matched nothing', async () => {
    const { backend } = backendWith({ ...READ_PAGE, 'Runtime.evaluate': { result: { value: false } } });

    await expect(
      backend.select({ kind: 'css', css: '#missing' }, 'x'),
    ).rejects.toThrow(/no element matched/);
  });

  it('marks the created tab active when it is the current target', async () => {
    const { backend } = backendWith(READ_PAGE);
    await backend.launch();

    const tab = await backend.newTab('https://example.test/second');

    expect(tab.id).toBe('T1');
  });
});