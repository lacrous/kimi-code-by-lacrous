import { describe, expect, it } from 'vitest';

import { normalizeKey, parseGeometry, parseMonitors, parseWindows } from '#/features/computerUse/ubuntuBackend';

describe('parseGeometry', () => {
  it('reads width and height from an xdotool geometry string', () => {
    expect(parseGeometry('1920 1080')).toEqual({ width: 1920, height: 1080 });
  });

  it('accepts the offset form', () => {
    expect(parseGeometry('1280x720+0+0')).toEqual({ width: 1280, height: 720 });
  });

  it('rejects an unparseable string', () => {
    expect(() => parseGeometry('nonsense')).toThrow(/cannot parse geometry/);
  });
});

describe('parseMonitors', () => {
  const XRANDR = [
    'Screen 0: minimum 16 x 16, current 1366 x 768, maximum 32767 x 32767',
    'eDP-1 connected primary 1366x768+0+0 (normal left inverted right x axis y axis) 340mm x 190mm',
    '   1366x768      59.80*+',
  ].join('\n');

  it('reads the connected monitor from real xrandr output', () => {
    const monitors = parseMonitors(XRANDR);

    expect(monitors).toEqual([
      { index: 0, name: 'eDP-1', geometry: { width: 1366, height: 768 }, primary: true },
    ]);
  });

  it('indexes a second monitor and marks the primary', () => {
    const monitors = parseMonitors(
      [
        'HDMI-1 connected 1920x1080+1366+0 (normal) 509mm x 286mm',
        'eDP-1 connected primary 1366x768+0+0 (normal) 340mm x 190mm',
      ].join('\n'),
    );

    expect(monitors.map((m) => [m.index, m.name, m.primary])).toEqual([
      [0, 'HDMI-1', false],
      [1, 'eDP-1', true],
    ]);
  });

  it('ignores disconnected outputs', () => {
    const monitors = parseMonitors(
      ['DP-1 disconnected (normal left inverted right x axis y axis)', 'eDP-1 connected 1366x768+0+0 (normal)'].join('\n'),
    );

    expect(monitors.map((m) => m.name)).toEqual(['eDP-1']);
  });

  it('returns nothing when no monitor is connected', () => {
    expect(parseMonitors('Screen 0: minimum 16 x 16, current 1366 x 768')).toEqual([]);
  });
});

describe('parseWindows', () => {
  const WMCTRL_OUTPUT = [
    'Window id: 0x3200007:',
    '  Client Name: chromium',
    '  Window Name: Lacrous Kimi Code - Chromium',
    '  Absolute upper-left X: 10',
    '  Absolute upper-left Y: 20',
    '  Width: 800',
    '  Height: 600',
    'Window id: 0x3400003:',
    '  Client Name: gnome-terminal',
    '  Window Name: agent@vm',
    '  Absolute upper-left X: 0',
    '  Absolute upper-left Y: 0',
    '  Width: 1200',
    '  Height: 800',
  ].join('\n');

  it('reads every window block', () => {
    const windows = parseWindows(WMCTRL_OUTPUT.split('\n'));

    expect(windows).toHaveLength(2);
  });

  it('captures id, title, application and geometry', () => {
    const [first] = parseWindows(WMCTRL_OUTPUT.split('\n'));

    expect(first?.id).toBe('0x3200007');
    expect(first?.title).toBe('Lacrous Kimi Code - Chromium');
    expect(first?.application).toBe('chromium');
    expect(first?.geometry).toEqual({ width: 800, height: 600 });
    expect(first?.x).toBe(10);
    expect(first?.y).toBe(20);
  });

  it('skips a block with no window name', () => {
    const windows = parseWindows([
      'Window id: 0x1:',
      '  Client Name: ghost',
      'Window id: 0x2:',
      '  Window Name: real',
    ].join('\n').split('\n'));

    expect(windows.map((w) => w.id)).toEqual(['0x2']);
  });

  it('returns nothing for empty output', () => {
    expect(parseWindows([])).toEqual([]);
  });
});

describe('normalizeKey', () => {
  it('maps the common aliases to xdotool key names', () => {
    expect(normalizeKey('enter')).toBe('Return');
    expect(normalizeKey('esc')).toBe('Escape');
    expect(normalizeKey('cmd')).toBe('super');
    expect(normalizeKey('pageup')).toBe('Prior');
  });

  it('is case-insensitive', () => {
    expect(normalizeKey('ENTER')).toBe('Return');
  });

  it('passes an already-valid key through', () => {
    expect(normalizeKey('a')).toBe('a');
    expect(normalizeKey('F5')).toBe('F5');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeKey('  tab  ')).toBe('Tab');
  });
});
