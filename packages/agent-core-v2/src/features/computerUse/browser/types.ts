export interface BrowserFrame {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly accessibility: readonly BrowserNode[];
  readonly screenshot: Uint8Array | undefined;
  readonly changed: boolean;
}

export interface BrowserNode {
  readonly role: string;
  readonly name: string;
  readonly backendNodeId: number | undefined;
  readonly focused: boolean;
}

export interface BrowserTarget {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
}

export interface BrowserBackend {
  launch(options?: { readonly headless?: boolean }): Promise<void>;
  navigate(url: string): Promise<BrowserFrame>;
  reload(): Promise<BrowserFrame>;
  back(): Promise<BrowserFrame>;
  forward(): Promise<BrowserFrame>;
  readPage(): Promise<BrowserFrame>;
  screenshot(): Promise<Uint8Array>;
  tabs(): Promise<readonly BrowserTarget[]>;
  newTab(url?: string): Promise<BrowserTarget>;
  closeTab(id: string): Promise<void>;
  switchTab(id: string): Promise<void>;
  click(target: BrowserSelector): Promise<void>;
  type(target: BrowserSelector, text: string): Promise<void>;
  select(target: BrowserSelector, value: string): Promise<void>;
  waitFor(target: BrowserSelector, timeoutMs?: number): Promise<boolean>;
  upload(target: BrowserSelector, filePath: string): Promise<void>;
  download(selector?: BrowserSelector): Promise<string>;
  close(): Promise<void>;
}

export type BrowserSelector =
  | { readonly kind: 'role'; readonly role: string; readonly name: string }
  | { readonly kind: 'backendNodeId'; readonly backendNodeId: number }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'css'; readonly css: string };

export function describeSelector(selector: BrowserSelector): string {
  switch (selector.kind) {
    case 'role':
      return `${selector.role} "${selector.name}"`;
    case 'backendNodeId':
      return `node ${String(selector.backendNodeId)}`;
    case 'text':
      return `text "${selector.text}"`;
    case 'css':
      return selector.css;
  }
}

export function isSelector(value: unknown): value is BrowserSelector {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'role' || kind === 'backendNodeId' || kind === 'text' || kind === 'css';
}