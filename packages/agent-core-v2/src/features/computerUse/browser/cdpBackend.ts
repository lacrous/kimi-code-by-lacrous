import { once } from 'node:events';
import type { EventEmitter } from 'node:events';

import type {
  BrowserBackend,
  BrowserFrame,
  BrowserNode,
  BrowserSelector,
  BrowserTarget,
} from '#/features/computerUse/browser/types';

export interface CdpSocket {
  send(payload: string): void;
  close(): void;
  on(event: 'message', handler: (data: string) => void): void;
  on(event: 'close', handler: () => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
}

export interface CdpConnection {
  call(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  close(): void;
}

interface PendingCall {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

export class CdpClient implements CdpConnection {
  private readonly _socket: CdpSocket;
  private readonly _pending = new Map<number, PendingCall>();
  private readonly _listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  private _nextId = 1;
  private _closed = false;

  constructor(socket: CdpSocket) {
    this._socket = socket;
    socket.on('message', (data) => {
      this._onMessage(data);
    });
    socket.on('close', () => {
      this._closed = true;
      for (const pending of this._pending.values()) {
        pending.reject(new Error('CDP connection closed'));
      }
      this._pending.clear();
    });
    socket.on('error', (error) => {
      for (const pending of this._pending.values()) {
        pending.reject(error);
      }
      this._pending.clear();
    });
  }

  call(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this._closed) {
      return Promise.reject(new Error(`CDP connection closed before ${method}`));
    }
    const id = this._nextId++;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) message['sessionId'] = sessionId;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
    });
    this._socket.send(JSON.stringify(message));
    return promise;
  }

  on(method: string, handler: (params: Record<string, unknown>) => void): void {
    const set = this._listeners.get(method) ?? new Set();
    set.add(handler);
    this._listeners.set(method, set);
  }

  close(): void {
    this._closed = true;
    this._socket.close();
  }

  private _onMessage(data: string): void {
    const message = JSON.parse(data) as Record<string, unknown>;
    if (typeof message['id'] === 'number') {
      const pending = this._pending.get(message['id']);
      if (pending === undefined) return;
      this._pending.delete(message['id']);
      if (message['error'] !== undefined) {
        const error = message['error'] as { message?: string };
        pending.reject(new Error(error.message ?? 'CDP call failed'));
      } else {
        pending.resolve((message['result'] ?? {}) as Record<string, unknown>);
      }
      return;
    }
    const method = message['method'];
    if (typeof method !== 'string') return;
    for (const handler of this._listeners.get(method) ?? []) {
      handler((message['params'] ?? {}) as Record<string, unknown>);
    }
  }
}

export interface CdpBrowserOptions {
  readonly endpoint: string;
  readonly connectionFactory?: (options: CdpSocketOptions) => Promise<CdpSocket>;
  readonly defaultTimeoutMs?: number;
}

export interface CdpSocketOptions {
  readonly endpoint: string;
  readonly headers?: Readonly<Record<string, string>>;
}

type WebSocketFactory = (options: CdpSocketOptions) => CdpSocket;

function globalWebSocketFactory(): WebSocketFactory | undefined {
  const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof ctor !== 'function') return undefined;
  return (options) => new (ctor as new (url: string) => CdpSocket)(options.endpoint);
}

export function connectCdpSocket(options: CdpSocketOptions): Promise<CdpSocket> {
  const factory = globalWebSocketFactory();
  if (factory === undefined) {
    return Promise.reject(
      new Error(
        'No global WebSocket is available. Pass connectionFactory to supply a socket.',
      ),
    );
  }
  const socket = factory(options);
  return once(socket as unknown as EventEmitter, 'open').then(() => socket);
}

export class CdpBrowserBackend implements BrowserBackend {
  private readonly _endpoint: string;
  private readonly _connect: (options: CdpSocketOptions) => Promise<CdpSocket>;
  private _client: CdpClient | undefined;
  private _sessionId: string | undefined;
  private _targetId: string | undefined;

  constructor(options: CdpBrowserOptions) {
    this._endpoint = options.endpoint;
    this._connect = options.connectionFactory ?? connectCdpSocket;
  }

  private async client(): Promise<CdpClient> {
    this._client ??= new CdpClient(await this._connect({ endpoint: this._endpoint }));
    return this._client;
  }

  private async session(): Promise<{ client: CdpClient; sessionId: string }> {
    const client = await this.client();
    if (this._sessionId === undefined) {
      const result = await client.call('Target.createTarget', { url: 'about:blank' });
      const targetId = result['targetId'];
      if (typeof targetId !== 'string') {
        throw new TypeError('CDP did not return a target id');
      }
      this._targetId = targetId;
      const attached = await client.call('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      const sessionId = attached['sessionId'];
      if (typeof sessionId !== 'string') {
        throw new TypeError('CDP did not return a session id');
      }
      this._sessionId = sessionId;
    }
    return { client, sessionId: this._sessionId };
  }

  async launch(): Promise<void> {
    const { sessionId } = await this.session();
    await this.call('Page.enable', {}, sessionId);
    await this.call('Runtime.enable', {}, sessionId);
    await this.call('DOM.enable', {}, sessionId);
    await this.call('Accessibility.enable', {}, sessionId);
  }

  private async call(
    method: string,
    params: Record<string, unknown>,
    sessionId: string,
  ): Promise<Record<string, unknown>> {
    const client = await this.client();
    return client.call(method, params, sessionId);
  }

  async navigate(url: string): Promise<BrowserFrame> {
    const { sessionId } = await this.session();
    const loaded = new Promise<void>((resolve) => {
      void this.client().then((client) =>
        client.on('Page.loadEventFired', () => {
          resolve();
        }),
      );
    });
    await this.call('Page.navigate', { url }, sessionId);
    await loaded;
    return this.readPage();
  }

  async readPage(): Promise<BrowserFrame> {
    const { sessionId } = await this.session();
    const [url, title, text, ax] = await Promise.all([
      this.call('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId),
      this.call('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId),
      this.call(
        'Runtime.evaluate',
        { expression: 'document.body ? document.body.innerText : ""', returnByValue: true },
        sessionId,
      ),
      this.call('Accessibility.getFullAXTree', {}, sessionId),
    ]);
    return {
      url: valueOf(url),
      title: valueOf(title),
      text: valueOf(text),
      accessibility: parseAxTree(ax),
      screenshot: undefined,
      changed: true,
    };
  }

  async screenshot(): Promise<Uint8Array> {
    const { sessionId } = await this.session();
    const result = await this.call('Page.captureScreenshot', { format: 'png' }, sessionId);
    const data = result['data'];
    if (typeof data !== 'string') {
      throw new TypeError('CDP screenshot returned no data');
    }
    return new Uint8Array(Buffer.from(data, 'base64'));
  }

  async tabs(): Promise<readonly BrowserTarget[]> {
    const client = await this.client();
    const result = await client.call('Target.getTargets');
    const infos = (result['targetInfos'] ?? []) as { targetId: string; url: string; title: string }[];
    return infos
      .filter((info) => info.targetId === this._targetId || info.url !== 'about:blank')
      .map((info) => ({
        id: info.targetId,
        url: info.url,
        title: info.title,
        active: info.targetId === this._targetId,
      }));
  }

  async newTab(url?: string): Promise<BrowserTarget> {
    const client = await this.client();
    const result = await client.call('Target.createTarget', { url: url ?? 'about:blank' });
    const targetId = result['targetId'];
    if (typeof targetId !== 'string') {
      throw new TypeError('CDP did not return a target id');
    }
    return { id: targetId, url: url ?? 'about:blank', title: '', active: targetId === this._targetId };
  }

  async closeTab(id: string): Promise<void> {
    const client = await this.client();
    await client.call('Target.closeTarget', { targetId: id });
  }

  async switchTab(id: string): Promise<void> {
    this._targetId = id;
    this._sessionId = undefined;
  }

  async reload(): Promise<BrowserFrame> {
    const { sessionId } = await this.session();
    await this.call('Page.reload', {}, sessionId);
    return this.readPage();
  }

  async back(): Promise<BrowserFrame> {
    return this._history(-1);
  }

  async forward(): Promise<BrowserFrame> {
    return this._history(1);
  }

  private async _history(delta: number): Promise<BrowserFrame> {
    const { sessionId } = await this.session();
    await this.call(
      'Page.getNavigationHistory',
      {},
      sessionId,
    );
    const result = await this.call(
      'Runtime.evaluate',
      { expression: `history.go(${String(delta)})`, returnByValue: true },
      sessionId,
    );
    void result;
    return this.readPage();
  }

  async click(target: BrowserSelector): Promise<void> {
    await this.type(target, '');
  }

  async type(target: BrowserSelector, text: string): Promise<void> {
    const { sessionId } = await this.session();
    const selector = toSelectorExpression(target);
    await this.call(
      'Runtime.evaluate',
      {
        expression: `(() => { const el = ${selector}; if (!el) throw new Error('no such element'); el.focus(); })()`,
        returnByValue: true,
      },
      sessionId,
    );
    for (const ch of text) {
      await this.call('Input.insertText', { text: ch }, sessionId);
    }
  }

  async select(target: BrowserSelector, value: string): Promise<void> {
    const { sessionId } = await this.session();
    const selector = toSelectorExpression(target);
    const result = await this.call(
      'Runtime.evaluate',
      {
        expression: `(() => { const el = ${selector}; if (!el) return false; el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
        returnByValue: true,
      },
      sessionId,
    );
    if (valueOf(result) !== 'true') {
      throw new Error('no element matched the select target');
    }
  }

  async waitFor(target: BrowserSelector, _timeoutMs = 5_000): Promise<boolean> {
    const { sessionId } = await this.session();
    const selector = toSelectorExpression(target);
    const result = await this.call(
      'Runtime.evaluate',
      { expression: `${selector} !== null && ${selector} !== undefined`, returnByValue: true },
      sessionId,
    );
    return valueOf(result) === 'true';
  }

  async upload(target: BrowserSelector, filePath: string): Promise<void> {
    const { sessionId } = await this.session();
    const selector = toSelectorExpression(target);
    const document = await this.call(
      'DOM.getDocument',
      { depth: 1 },
      sessionId,
    );
    const rootNodeId = (document['root'] as { nodeId?: number } | undefined)?.nodeId;
    if (rootNodeId === undefined) {
      throw new Error('CDP did not return a document root');
    }
    const queried = await this.call(
      'DOM.querySelector',
      { nodeId: rootNodeId, selector: selector.replaceAll(/^document\.querySelector\('?|'\?\)$/g, '') },
      sessionId,
    );
    const nodeId = queried['nodeId'];
    if (typeof nodeId !== 'number' || nodeId === 0) {
      throw new Error('no file input matched the upload target');
    }
    await this.call('DOM.setFileInputFiles', { files: [filePath], nodeId }, sessionId);
  }

  async download(selector?: BrowserSelector): Promise<string> {
    const { sessionId } = await this.session();
    const params: Record<string, unknown> = { behavior: 'allow' };
    if (selector !== undefined) {
      Object.assign(params, { url: await this._hrefFor(selector) });
    }
    await this.call('Page.setDownloadBehavior', params, sessionId);
    return this._endpoint;
  }

  private async _hrefFor(selector: BrowserSelector): Promise<string> {
    const { sessionId } = await this.session();
    const result = await this.call(
      'Runtime.evaluate',
      { expression: `(${toSelectorExpression(selector)} ?? {}).href ?? ''`, returnByValue: true },
      sessionId,
    );
    return valueOf(result);
  }

  async close(): Promise<void> {
    this._client?.close();
    this._client = undefined;
    this._sessionId = undefined;
  }
}

function valueOf(result: Record<string, unknown>): string {
  const value = result['result'] as { value?: unknown } | undefined;
  if (value === undefined) return '';
  const inner = value.value;
  if (typeof inner === 'string') return inner;
  if (typeof inner === 'number' || typeof inner === 'boolean') return String(inner);
  return '';
}

export function parseAxTree(tree: Record<string, unknown>): BrowserNode[] {
  const nodes = (tree['nodes'] ?? []) as {
    role?: { value?: string };
    name?: { value?: string };
    backendDOMNodeId?: number;
    focused?: boolean;
  }[];
  return nodes.map((node) => ({
    role: node.role?.value ?? '',
    name: node.name?.value ?? '',
    backendNodeId: node.backendDOMNodeId,
    focused: node.focused === true,
  }));
}

export function toSelectorExpression(selector: BrowserSelector): string {
  switch (selector.kind) {
    case 'css':
      return `document.querySelector(${JSON.stringify(selector.css)})`;
    case 'text':
      return `[...document.querySelectorAll('a,button,input,textarea,select,[role]')].find(el => (el.innerText ?? el.value ?? '').trim() === ${JSON.stringify(selector.text)})`;
    case 'role':
      return `document.querySelector(${JSON.stringify(`[role="${selector.role}"]`)})`;
    case 'backendNodeId':
      return `document.querySelector(${JSON.stringify(`[data-cdp-node="${String(selector.backendNodeId)}"]`)})`;
  }
}