const RTF_SKIP_DESTINATIONS = new Set([
  'fonttbl',
  'colortbl',
  'stylesheet',
  'info',
  'pict',
  'object',
  'themedata',
  'colorschememapping',
  'latentstyles',
  'datastore',
  'generator',
  'listtable',
  'listoverridetable',
  'rsidtbl',
  'xmlnstbl',
  'mmathPr',
  'filetbl',
  'revtbl',
]);

const RTF_CONTROL_CHARS: Record<string, string> = {
  emdash: '\u2014',
  endash: '\u2013',
  lquote: '\u2018',
  rquote: '\u2019',
  ldblquote: '\u201c',
  rdblquote: '\u201d',
  bullet: '\u2022',
  enspace: '\u2002',
  emspace: '\u2003',
  nbsp: '\u00a0',
};

const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020,
  0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152,
  0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

function isAsciiLetter(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function isAsciiDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function fromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

export function extractRtfText(source: string): string | undefined {
  if (!source.includes('{\\rtf')) return undefined;
  const out: string[] = [];
  const groupStack: boolean[] = [];
  let skipping = false;
  let skipNextGroup = false;
  let chars = 0;
  let i = 0;

  const push = (text: string): void => {
    if (skipping || text.length === 0) return;
    out.push(text);
    chars += text.length;
  };

  while (i < source.length && chars < 8_000_000) {
    const ch = source[i];
    if (ch === undefined) break;
    if (ch === '{') {
      groupStack.push(skipping);
      i += 1;
      continue;
    }
    if (ch === '}') {
      skipping = groupStack.pop() ?? false;
      i += 1;
      continue;
    }
    if (ch !== '\\') {
      if (ch !== '\r' && ch !== '\n') push(ch);
      i += 1;
      continue;
    }
    const next = source[i + 1];
    if (next === undefined) break;
    if (next === '\r' || next === '\n') {
      i += 2;
      continue;
    }
    if (next === '*') {
      skipNextGroup = true;
      i += 2;
      continue;
    }
    if (next === "'") {
      const code = Number.parseInt(source.slice(i + 2, i + 4), 16);
      const mapped = Number.isNaN(code) ? undefined : CP1252_HIGH[code];
      push(String.fromCharCode(mapped ?? (Number.isNaN(code) ? 63 : code)));
      i += 4;
      continue;
    }
    if (!isAsciiLetter(next)) {
      if (next === '~') push(' ');
      else if (next !== '-') push(next);
      i += 2;
      continue;
    }

    let wordEnd = i + 1;
    while (wordEnd < source.length) {
      const c = source[wordEnd];
      if (c === undefined || !isAsciiLetter(c)) break;
      wordEnd += 1;
    }
    const word = source.slice(i + 1, wordEnd);
    let cursor = wordEnd;
    let negative = false;
    if (source[cursor] === '-') {
      negative = true;
      cursor += 1;
    }
    const digitsStart = cursor;
    while (cursor < source.length) {
      const d = source[cursor];
      if (d === undefined || !isAsciiDigit(d)) break;
      cursor += 1;
    }
    let param: number | undefined;
    if (cursor > digitsStart) {
      const raw = Number.parseInt(source.slice(digitsStart, cursor), 10);
      param = negative ? -raw : raw;
    }
    if (source[cursor] === ' ') cursor += 1;
    i = cursor;

    if (skipNextGroup || RTF_SKIP_DESTINATIONS.has(word)) {
      skipNextGroup = false;
      let probe = i;
      while (probe < source.length) {
        const c = source[probe];
        if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '\n') break;
        probe += 1;
      }
      if (source[probe] === '{') {
        groupStack.push(skipping);
        skipping = true;
        i = probe + 1;
      }
      continue;
    }
    if (word === 'bin') {
      i += Math.max(0, param ?? 0);
      continue;
    }
    if (word === 'u' && param !== undefined) {
      push(fromCodePoint(param < 0 ? param + 0x10000 : param));
      let remaining = 1;
      while (remaining > 0 && i < source.length) {
        const c = source[i];
        if (c === '\\') {
          const n = source[i + 1];
          if (n === "'") {
            i += 4;
          } else if (n !== undefined && isAsciiLetter(n)) {
            let end = i + 1;
            while (end < source.length) {
              const e = source[end];
              if (e === undefined || !isAsciiLetter(e)) break;
              end += 1;
            }
            i = end;
          } else {
            i += 2;
          }
        } else {
          i += 1;
        }
        remaining -= 1;
      }
      continue;
    }
    if (word === 'par' || word === 'line' || word === 'sect' || word === 'page' || word === 'row') {
      push('\n');
      continue;
    }
    if (word === 'tab') {
      push('\t');
      continue;
    }
    const mapped = RTF_CONTROL_CHARS[word];
    if (mapped !== undefined) push(mapped);
  }
  const text = out.join('').trimEnd();
  return text.length === 0 ? undefined : text;
}
