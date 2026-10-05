import { LoopDetector, type ActionRecord, type ActionFailureClass } from '#/features/computerUse/observation';
import {
  describeSelector,
  type BrowserBackend,
  type BrowserFrame,
  type BrowserSelector,
  type BrowserTarget,
} from '#/features/computerUse/browser/types';

export interface BrowserControllerOptions {
  readonly backend: BrowserBackend;
  readonly loopThreshold?: number;
  readonly onAction?: (record: ActionRecord) => void;
  readonly now?: () => number;
}

export class BrowserControlError extends Error {
  readonly failureClass: ActionFailureClass;

  constructor(message: string, failureClass: ActionFailureClass = 'tool') {
    super(message);
    this.name = 'BrowserControlError';
    this.failureClass = failureClass;
  }
}

function assertNavigable(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BrowserControlError(`"${url}" is not a valid URL.`, 'invalid_action');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BrowserControlError(
      `Only http and https URLs can be opened, got "${parsed.protocol}".`,
      'invalid_action',
    );
  }
  return parsed;
}

function summarizeFrame(frame: BrowserFrame, previousUrl: string | undefined): string {
  const changed = previousUrl === undefined ? true : frame.url !== previousUrl;
  const nodes = frame.accessibility.length;
  return [
    `${frame.title.length === 0 ? '(untitled)' : frame.title} — ${frame.url}`,
    `Accessibility nodes: ${String(nodes)}`,
    changed ? 'Page changed.' : 'Same URL as before.',
  ].join('\n');
}

export class BrowserController {
  private readonly _backend: BrowserBackend;
  private readonly _loops: LoopDetector;
  private readonly _onAction: ((record: ActionRecord) => void) | undefined;
  private readonly _now: () => number;
  private _url: string | undefined;
  private _tab: BrowserTarget | undefined;

  constructor(options: BrowserControllerOptions) {
    this._backend = options.backend;
    this._loops = new LoopDetector(options.loopThreshold ?? 5);
    this._onAction = options.onAction;
    this._now = options.now ?? Date.now;
  }

  async launch(headless = false): Promise<void> {
    return this._run('launch', { headless }, () => this._backend.launch({ headless }));
  }

  async navigate(url: string): Promise<BrowserFrame> {
    const parsed = assertNavigable(url);
    return this._run('navigate', { url: parsed.href }, async () => {
      const frame = await this._backend.navigate(parsed.href);
      this._url = frame.url;
      return frame;
    });
  }

  async reload(): Promise<BrowserFrame> {
    return this._run('reload', {}, () => this._backend.reload());
  }

  async back(): Promise<BrowserFrame> {
    return this._run('back', {}, () => this._backend.back());
  }

  async forward(): Promise<BrowserFrame> {
    return this._run('forward', {}, () => this._backend.forward());
  }

  async readPage(): Promise<BrowserFrame> {
    return this._run('read_page', {}, () => this._backend.readPage());
  }

  async screenshot(): Promise<Uint8Array> {
    return this._run('screenshot', {}, () => this._backend.screenshot());
  }

  async tabs(): Promise<readonly BrowserTarget[]> {
    return this._run('tabs', {}, () => this._backend.tabs());
  }

  async newTab(url?: string): Promise<BrowserTarget> {
    const href = url === undefined ? undefined : assertNavigable(url).href;
    return this._run('new_tab', { url: href }, async () => {
      const tab = await this._backend.newTab(href);
      this._tab = tab;
      return tab;
    });
  }

  async closeTab(id: string): Promise<void> {
    return this._run('close_tab', { id }, () => this._backend.closeTab(id));
  }

  async switchTab(id: string): Promise<void> {
    return this._run('switch_tab', { id }, async () => {
      await this._backend.switchTab(id);
      const tabs = await this._backend.tabs();
      this._tab = tabs.find((t) => t.id === id);
    });
  }

  async click(target: BrowserSelector): Promise<void> {
    return this._run('click', target, () => this._backend.click(target));
  }

  async type(target: BrowserSelector, text: string): Promise<void> {
    return this._run('type', { target, length: text.length }, () => this._backend.type(target, text));
  }

  async select(target: BrowserSelector, value: string): Promise<void> {
    return this._run('select', { target, value }, () => this._backend.select(target, value));
  }

  async waitFor(target: BrowserSelector, timeoutMs?: number): Promise<boolean> {
    return this._run('wait_for', { target, timeoutMs }, () => this._backend.waitFor(target, timeoutMs));
  }

  async upload(target: BrowserSelector, filePath: string): Promise<void> {
    return this._run('upload', { target, filePath }, () => this._backend.upload(target, filePath));
  }

  async download(selector?: BrowserSelector): Promise<string> {
    return this._run('download', selector ?? {}, () => this._backend.download(selector));
  }

  async close(): Promise<void> {
    return this._run('close', {}, () => this._backend.close());
  }

  get currentUrl(): string | undefined {
    return this._url;
  }

  get currentTab(): BrowserTarget | undefined {
    return this._tab;
  }

  summarize(frame: BrowserFrame): string {
    return summarizeFrame(frame, this._url);
  }

  describe(target: BrowserSelector): string {
    return describeSelector(target);
  }

  detectLoop(action: string, args: Record<string, unknown>): boolean {
    return this._loops.record(action, args);
  }

  private async _run<T>(action: string, args: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const startedAt = this._now();
    try {
      const result = await fn();
      this._onAction?.({
        action,
        arguments: args,
        startedAt,
        durationMs: this._now() - startedAt,
        success: true,
        failureClass: undefined,
        error: undefined,
      });
      return result;
    } catch (error) {
      const failureClass = error instanceof BrowserControlError ? error.failureClass : 'tool';
      const message = error instanceof Error ? error.message : String(error);
      this._onAction?.({
        action,
        arguments: args,
        startedAt,
        durationMs: this._now() - startedAt,
        success: false,
        failureClass,
        error: message,
      });
      throw error;
    }
  }
}
