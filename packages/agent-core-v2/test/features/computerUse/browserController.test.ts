import { describe, expect, it, vi } from 'vitest';

import {
  BrowserControlError,
  BrowserController,
} from '#/features/computerUse/browser/browserController';
import {
  describeSelector,
  isSelector,
  type BrowserBackend,
  type BrowserFrame,
} from '#/features/computerUse/browser/types';

const FRAME: BrowserFrame = {
  url: 'https://example.test/dashboard',
  title: 'Dashboard',
  text: 'Welcome back',
  accessibility: [
    { role: 'button', name: 'Sign in', backendNodeId: 12, focused: false },
    { role: 'textbox', name: 'Email', backendNodeId: 13, focused: true },
  ],
  screenshot: undefined,
  changed: true,
};

function fakeBackend(): BrowserBackend & { calls: string[] } {
  const calls: string[] = [];
  const backend: BrowserBackend & { calls: string[] } = {
    calls,
    launch: async () => {
      calls.push('launch');
    },
    navigate: async (url) => {
      calls.push(`navigate:${url}`);
      return { ...FRAME, url };
    },
    reload: async () => {
      calls.push('reload');
      return FRAME;
    },
    back: async () => {
      calls.push('back');
      return FRAME;
    },
    forward: async () => {
      calls.push('forward');
      return FRAME;
    },
    readPage: async () => {
      calls.push('read_page');
      return FRAME;
    },
    screenshot: async () => {
      calls.push('screenshot');
      return new Uint8Array([0x89, 0x50]);
    },
    tabs: async () => {
      calls.push('tabs');
      return [{ id: 't1', url: FRAME.url, title: FRAME.title, active: true }];
    },
    newTab: async (url) => {
      calls.push(`new_tab:${url ?? 'about:blank'}`);
      return { id: 't2', url: url ?? 'about:blank', title: '', active: true };
    },
    closeTab: async (id) => {
      calls.push(`close_tab:${id}`);
    },
    switchTab: async (id) => {
      calls.push(`switch_tab:${id}`);
    },
    click: async (target) => {
      calls.push(`click:${describeSelector(target)}`);
    },
    type: async (target, text) => {
      calls.push(`type:${describeSelector(target)}:${text.length}`);
    },
    select: async (target, value) => {
      calls.push(`select:${describeSelector(target)}:${value}`);
    },
    waitFor: async (target) => {
      calls.push(`wait:${describeSelector(target)}`);
      return true;
    },
    upload: async (target, filePath) => {
      calls.push(`upload:${describeSelector(target)}:${filePath}`);
    },
    download: async () => {
      calls.push('download');
      return '/tmp/report.pdf';
    },
    close: async () => {
      calls.push('close');
    },
  };
  return backend;
}

describe('BrowserController', () => {
  it('navigates and records the resulting url', async () => {
    const backend = fakeBackend();
    const controller = new BrowserController({ backend });

    const frame = await controller.navigate('https://example.test/dashboard');

    expect(backend.calls).toContain('navigate:https://example.test/dashboard');
    expect(frame.title).toBe('Dashboard');
    expect(controller.currentUrl).toBe('https://example.test/dashboard');
  });

  it('rejects a non-navigable url before touching the browser', async () => {
    const backend = fakeBackend();
    const controller = new BrowserController({ backend });

    await expect(controller.navigate('not a url')).rejects.toThrow(/not a valid URL/);
    await expect(controller.navigate('file:///etc/passwd')).rejects.toThrow(
      /Only http and https/,
    );
    expect(backend.calls).toHaveLength(0);
  });

  it('addresses a click by role and name, never by coordinate', async () => {
    const backend = fakeBackend();
    const controller = new BrowserController({ backend });

    await controller.click({ kind: 'role', role: 'button', name: 'Sign in' });

    expect(backend.calls).toEqual(['click:button "Sign in"']);
  });

  it('reports whether the page changed since the last navigation', async () => {
    const backend = fakeBackend();
    const controller = new BrowserController({ backend });
    await controller.navigate('https://example.test/a');

    const sameUrl = controller.summarize({ ...FRAME, url: 'https://example.test/a' });
    const newUrl = controller.summarize({ ...FRAME, url: 'https://example.test/b' });

    expect(sameUrl).toContain('Same URL as before.');
    expect(newUrl).toContain('Page changed.');
  });

  it('summarizes a frame with title, url and node count', async () => {
    const controller = new BrowserController({ backend: fakeBackend() });
    const frame = { ...FRAME, url: 'https://example.test/z' };

    const summary = controller.summarize(frame);

    expect(summary).toContain('Dashboard — https://example.test/z');
    expect(summary).toContain('Accessibility nodes: 2');
  });

  it('labels an untitled page rather than leaving a blank', async () => {
    const controller = new BrowserController({ backend: fakeBackend() });

    expect(controller.summarize({ ...FRAME, title: '', url: 'https://e.test/' })).toContain(
      '(untitled)',
    );
  });

  it('tracks the active tab when switching', async () => {
    const backend = fakeBackend();
    const controller = new BrowserController({ backend });
    await controller.newTab('https://example.test/new');

    expect(controller.currentTab?.id).toBe('t2');
  });

  it('records a successful action', async () => {
    const records: { action: string; success: boolean }[] = [];
    const controller = new BrowserController({
      backend: fakeBackend(),
      onAction: (record) => records.push({ action: record.action, success: record.success }),
    });

    await controller.navigate('https://example.test/');

    expect(records).toEqual([
      { action: 'navigate', success: true },
    ]);
  });

  it('records a failure with its class', async () => {
    const records: { success: boolean; failureClass: string | undefined }[] = [];
    const backend = fakeBackend();
    backend.click = async () => {
      throw new BrowserControlError('no such node', 'invalid_action');
    };
    const controller = new BrowserController({
      backend,
      onAction: (record) =>
        records.push({ success: record.success, failureClass: record.failureClass }),
    });

    await expect(
      controller.click({ kind: 'role', role: 'button', name: 'Nope' }),
    ).rejects.toThrow('no such node');
    expect(records[0]).toEqual({ success: false, failureClass: 'invalid_action' });
  });

  it('validates the url passed to newTab', async () => {
    const backend = fakeBackend();
    const controller = new BrowserController({ backend });

    await expect(controller.newTab('javascript:alert(1)')).rejects.toThrow(/Only http and https/);
  });

  it('detects a repeated action past the threshold', async () => {
    const controller = new BrowserController({ backend: fakeBackend(), loopThreshold: 2 });
    const args = { target: { kind: 'css' as const, css: '#x' } };

    expect(controller.detectLoop('click', args)).toBe(false);
    expect(controller.detectLoop('click', args)).toBe(false);
    expect(controller.detectLoop('click', args)).toBe(true);
  });
});

describe('selectors', () => {
  it('renders each selector kind for the action log', () => {
    expect(describeSelector({ kind: 'role', role: 'button', name: 'Save' })).toBe('button "Save"');
    expect(describeSelector({ kind: 'backendNodeId', backendNodeId: 9 })).toBe('node 9');
    expect(describeSelector({ kind: 'text', text: 'Sign out' })).toBe('text "Sign out"');
    expect(describeSelector({ kind: 'css', css: '#submit' })).toBe('#submit');
  });

  it('validates an untrusted value before it becomes a target', () => {
    expect(isSelector({ kind: 'css', css: '#x' })).toBe(true);
    expect(isSelector({ kind: 'evil' })).toBe(false);
    expect(isSelector(null)).toBe(false);
    expect(isSelector('css')).toBe(false);
  });
});