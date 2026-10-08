import { inflateRawSync, inflateSync } from 'node:zlib';

const MAX_OBJECTS = 200_000;
const MAX_PAGES = 5_000;
const MAX_TOKENS = 4_000_000;
const MAX_OUTPUT_CHARS = 8_000_000;
const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const WORD_SPACE_THRESHOLD = -100;
const POSITION_EPSILON = 0.5;

type PdfToken =
  | { readonly kind: 'str'; readonly bytes: readonly number[] }
  | { readonly kind: 'num'; readonly value: number }
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'op'; readonly value: string }
  | { readonly kind: 'arrOpen' }
  | { readonly kind: 'arrClose' };

interface PdfObject {
  dict: string;
  start: number;
  end: number;
}

interface CMap {
  readonly codeBytes: number;
  readonly codes: Map<number, string>;
}

const WHITESPACE = new Set([' ', '\n', '\r', '\t', '\f', '\0']);
const DELIMITERS = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);
const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)/;
const OPERATOR_RE = /^[A-Za-z*'"]+/;

function isWhitespace(ch: string): boolean {
  return WHITESPACE.has(ch);
}

function isDelimiter(ch: string): boolean {
  return DELIMITERS.has(ch);
}

function readLiteralString(src: string, start: number): { token: PdfToken; next: number } {
  const bytes: number[] = [];
  let depth = 1;
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === undefined) break;
    if (ch === '\\') {
      const next = src[i + 1];
      i += 2;
      if (next === undefined) break;
      switch (next) {
        case 'n':
          bytes.push(10);
          break;
        case 'r':
          bytes.push(13);
          break;
        case 't':
          bytes.push(9);
          break;
        case 'b':
          bytes.push(8);
          break;
        case 'f':
          bytes.push(12);
          break;
        case '(':
        case ')':
        case '\\':
          bytes.push(next.charCodeAt(0));
          break;
        case '\r':
          if (src[i] === '\n') i += 1;
          break;
        case '\n':
          break;
        default: {
          if (next >= '0' && next <= '7') {
            let octal = next;
            while (octal.length < 3) {
              const digit = src[i];
              if (digit === undefined || digit < '0' || digit > '7') break;
              octal += digit;
              i += 1;
            }
            bytes.push(Number.parseInt(octal, 8) & 0xff);
          } else {
            bytes.push(next.charCodeAt(0));
          }
          break;
        }
      }
      continue;
    }
    if (ch === '(') {
      depth += 1;
      bytes.push(40);
      i += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return { token: { kind: 'str', bytes }, next: i + 1 };
      }
      bytes.push(41);
      i += 1;
      continue;
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
    i += 1;
  }
  return { token: { kind: 'str', bytes }, next: i };
}

function hexPair(digits: readonly string[], index: number): string {
  return `${digits[index] ?? ''}${digits[index + 1] ?? ''}`;
}

function readHexString(src: string, start: number): { token: PdfToken; next: number } {
  const digits: string[] = [];
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '>') break;
    if (ch !== undefined && !isWhitespace(ch)) digits.push(ch);
    i += 1;
  }
  if (digits.length % 2 === 1) digits.push('0');
  const bytes: number[] = [];
  for (let k = 0; k < digits.length; k += 2) {
    const value = Number.parseInt(hexPair(digits, k), 16);
    if (Number.isNaN(value)) break;
    bytes.push(value & 0xff);
  }
  return { token: { kind: 'str', bytes }, next: i + 1 };
}

function readName(src: string, start: number): { value: string; next: number } {
  let i = start + 1;
  let value = '';
  while (i < src.length) {
    const ch = src[i];
    if (ch === undefined || isWhitespace(ch) || isDelimiter(ch)) break;
    if (ch === '#') {
      const pair = src.slice(i + 1, i + 3);
      const decoded = Number.parseInt(pair, 16);
      if (pair.length === 2 && !Number.isNaN(decoded)) {
        value += String.fromCharCode(decoded);
        i += 3;
        continue;
      }
    }
    value += ch;
    i += 1;
  }
  return { value, next: i };
}

function tokenizePdf(src: string, limit: number): PdfToken[] {
  const tokens: PdfToken[] = [];
  let i = 0;
  while (i < src.length && tokens.length < limit) {
    const ch = src[i];
    if (ch === undefined) break;
    if (isWhitespace(ch)) {
      i += 1;
      continue;
    }
    if (ch === '%') {
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i += 1;
      continue;
    }
    if (ch === '(') {
      const read = readLiteralString(src, i);
      tokens.push(read.token);
      i = read.next;
      continue;
    }
    if (ch === '<' && src[i + 1] !== '<') {
      const read = readHexString(src, i);
      tokens.push(read.token);
      i = read.next;
      continue;
    }
    if (ch === '<' && src[i + 1] === '<') {
      tokens.push({ kind: 'op', value: '<<' });
      i += 2;
      continue;
    }
    if (ch === '>' && src[i + 1] === '>') {
      tokens.push({ kind: 'op', value: '>>' });
      i += 2;
      continue;
    }
    if (ch === '>') {
      i += 1;
      continue;
    }
    if (ch === '[') {
      tokens.push({ kind: 'arrOpen' });
      i += 1;
      continue;
    }
    if (ch === ']') {
      tokens.push({ kind: 'arrClose' });
      i += 1;
      continue;
    }
    if (ch === '{' || ch === '}') {
      i += 1;
      continue;
    }
    if (ch === '/') {
      const read = readName(src, i);
      tokens.push({ kind: 'name', value: read.value });
      i = read.next;
      continue;
    }
    const rest = src.slice(i, i + 24);
    const numberMatch = NUMBER_RE.exec(rest);
    if (numberMatch !== null && numberMatch[0].length > 0) {
      tokens.push({ kind: 'num', value: Number.parseFloat(numberMatch[0]) });
      i += numberMatch[0].length;
      continue;
    }
    const operatorMatch = OPERATOR_RE.exec(rest);
    if (operatorMatch !== null && operatorMatch[0].length > 0) {
      tokens.push({ kind: 'op', value: operatorMatch[0] });
      i += operatorMatch[0].length;
      continue;
    }
    i += 1;
  }
  return tokens;
}

function decodeAscii85(src: string): Uint8Array | undefined {
  const out: number[] = [];
  let tuple: number[] = [];
  let i = 0;
  if (src.startsWith('<~')) i = 2;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === undefined || isWhitespace(ch)) continue;
    if (ch === '~') break;
    if (ch === 'z' && tuple.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (ch < '!' || ch > 'u') return undefined;
    tuple.push(ch.charCodeAt(0) - 33);
    if (tuple.length === 5) {
      let value = 0;
      for (const digit of tuple) value = value * 85 + digit;
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
      tuple = [];
    }
  }
  if (tuple.length > 1) {
    const padding = 5 - tuple.length;
    let value = 0;
    for (let k = 0; k < 5; k += 1) value = value * 85 + (tuple[k] ?? 84);
    const bytes = [
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ];
    for (let k = 0; k < 4 - padding; k += 1) out.push(bytes[k] ?? 0);
  }
  return Uint8Array.from(out);
}

function decodeAsciiHex(src: string): Uint8Array {
  const digits: string[] = [];
  for (const ch of src) {
    if (ch === '>') break;
    if (!isWhitespace(ch)) digits.push(ch);
  }
  if (digits.length % 2 === 1) digits.push('0');
  const out = new Uint8Array(digits.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hexPair(digits, i * 2), 16) & 0xff;
  }
  return out;
}

function inflate(data: Uint8Array): Uint8Array {
  try {
    return new Uint8Array(inflateSync(data));
  } catch {
    return new Uint8Array(inflateRawSync(data));
  }
}

function decodeLatin1(bytes: Uint8Array): string {
  let out = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return out;
}

const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020,
  0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152,
  0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

function decodeWinAnsi(bytes: readonly number[]): string {
  let out = '';
  for (const byte of bytes) {
    const mapped = CP1252_HIGH[byte];
    out += mapped === undefined ? String.fromCharCode(byte) : String.fromCharCode(mapped);
  }
  return out;
}

function beCode(bytes: readonly number[]): number {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

function decodeUtf16Be(bytes: readonly number[]): string {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0));
  }
  if (bytes.length % 2 === 1) {
    out += String.fromCharCode(bytes[bytes.length - 1] ?? 0);
  }
  return out.replaceAll('\u0000', '');
}

function parseToUnicode(src: string): CMap | undefined {
  const tokens = tokenizePdf(src, MAX_TOKENS);
  const codes = new Map<number, string>();
  let codeBytes = 0;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined || token.kind !== 'op') {
      i += 1;
      continue;
    }
    if (token.value === 'begincodespacerange') {
      while (i < tokens.length) {
        const entry = tokens[i];
        if (entry !== undefined && entry.kind === 'op' && entry.value === 'endcodespacerange') {
          i += 1;
          break;
        }
        if (entry !== undefined && entry.kind === 'str') {
          codeBytes = Math.max(codeBytes, entry.bytes.length);
        }
        i += 1;
      }
      continue;
    }
    if (token.value === 'beginbfchar') {
      i += 1;
      while (i < tokens.length) {
        const entry = tokens[i];
        if (entry !== undefined && entry.kind === 'op' && entry.value === 'endbfchar') {
          i += 1;
          break;
        }
        const target = tokens[i + 1];
        if (entry !== undefined && entry.kind === 'str' && target !== undefined && target.kind === 'str') {
          codeBytes = Math.max(codeBytes, entry.bytes.length);
          codes.set(beCode(entry.bytes), decodeUtf16Be(target.bytes));
        }
        i += 2;
      }
      continue;
    }
    if (token.value === 'beginbfrange') {
      i += 1;
      while (i < tokens.length) {
        const entry = tokens[i];
        if (entry !== undefined && entry.kind === 'op' && entry.value === 'endbfrange') {
          i += 1;
          break;
        }
        const high = tokens[i + 1];
        const target = tokens[i + 2];
        if (entry?.kind !== 'str' || high?.kind !== 'str') {
          i += 3;
          continue;
        }
        codeBytes = Math.max(codeBytes, entry.bytes.length);
        const start = beCode(entry.bytes);
        const end = beCode(high.bytes);
        if (target?.kind === 'str') {
          for (let code = start; code <= end && code - start < 65_536; code += 1) {
            const shifted = [...target.bytes];
            const last = shifted.length - 1;
            if (last >= 0) {
              shifted[last] = ((shifted[last] ?? 0) + (code - start)) & 0xff;
            }
            codes.set(code, decodeUtf16Be(shifted));
          }
        } else if (target?.kind === 'arrOpen') {
          let cursor = i + 3;
          let offset = 0;
          while (cursor < tokens.length) {
            const item = tokens[cursor];
            if (item === undefined || item.kind === 'arrClose') break;
            if (item.kind === 'str') {
              codes.set(start + offset, decodeUtf16Be(item.bytes));
              offset += 1;
            }
            cursor += 1;
          }
          i = cursor;
          continue;
        }
        i += 3;
      }
      continue;
    }
    i += 1;
  }
  if (codes.size === 0) return undefined;
  return { codeBytes: Math.max(1, Math.min(codeBytes, 4)), codes };
}

function decodePdfBytes(bytes: readonly number[], cmap: CMap | undefined): string {
  if (cmap === undefined) return decodeWinAnsi(bytes);
  const width = cmap.codeBytes;
  let out = '';
  for (let i = 0; i + width <= bytes.length; i += width) {
    let code = 0;
    for (let k = 0; k < width; k += 1) code = code * 256 + (bytes[i + k] ?? 0);
    const mapped = cmap.codes.get(code);
    if (mapped !== undefined) out += mapped;
  }
  if (out.length === 0 && width > 1) return decodeUtf16Be(bytes);
  return out;
}

interface DictValue {
  readonly text: string;
  readonly next: number;
}

function readDictValue(dict: string, start: number): DictValue | undefined {
  let i = start;
  while (i < dict.length) {
    const ch = dict[i];
    if (ch === undefined || !isWhitespace(ch)) break;
    i += 1;
  }
  const ch = dict[i];
  if (ch === undefined) return undefined;
  if (ch === '<') {
    let depth = 0;
    let j = i;
    while (j < dict.length) {
      const c = dict[j];
      if (c === '<') depth += 1;
      else if (c === '>') {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          break;
        }
      }
      j += 1;
    }
    return { text: dict.slice(i, j), next: j };
  }
  if (ch === '[') {
    let depth = 0;
    let j = i;
    while (j < dict.length) {
      const c = dict[j];
      if (c === '[') depth += 1;
      else if (c === ']') {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          break;
        }
      }
      j += 1;
    }
    return { text: dict.slice(i, j), next: j };
  }
  if (ch === '/') {
    const read = readName(dict, i);
    return { text: `/${read.value}`, next: read.next };
  }
  const reference = /^\d{1,10}\s+\d{1,5}\s+R\b/.exec(dict.slice(i));
  if (reference !== null) return { text: reference[0], next: i + reference[0].length };
  let j = i;
  while (j < dict.length) {
    const c = dict[j];
    if (c === undefined || isWhitespace(c) || isDelimiter(c)) break;
    j += 1;
  }
  if (j === i) {
    if (ch === ']' || ch === '>' || ch === '}') return { text: ch, next: i + 1 };
    return undefined;
  }
  return { text: dict.slice(i, j), next: j };
}

function dictValue(dict: string, key: string): string | undefined {
  const pattern = new RegExp(`/${key}(?![A-Za-z0-9])`);
  const match = pattern.exec(dict);
  if (match === null) return undefined;
  const read = readDictValue(dict, match.index + match[0].length);
  return read?.text;
}

function dictRefs(value: string | undefined): number[] {
  if (value === undefined) return [];
  const refs: number[] = [];
  const pattern = /(\d{1,10})\s+\d{1,5}\s+R\b/g;
  let match = pattern.exec(value);
  while (match !== null) {
    refs.push(Number.parseInt(match[1] ?? '', 10));
    match = pattern.exec(value);
  }
  return refs;
}

function dictNames(value: string | undefined): string[] {
  if (value === undefined) return [];
  const names: string[] = [];
  const pattern = /\/([^\s/[\]<>(){}%]+)/g;
  let match = pattern.exec(value);
  while (match !== null) {
    names.push(match[1] ?? '');
    match = pattern.exec(value);
  }
  return names;
}

function dictNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(value);
  if (match === null) return undefined;
  return Number.parseFloat(match[0]);
}

class PdfDocument {
  private readonly objects = new Map<number, PdfObject>();
  private readonly raw: string;
  private readonly bytes: Uint8Array;
  private readonly decoded = new Set<number>();
  private readonly cmapCache = new Map<number, CMap | null>();

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.raw = decodeLatin1(bytes);
    this.scanObjects();
    this.expandObjectStreams();
  }

  get encrypted(): boolean {
    return /\/Encrypt\s+\d{1,10}\s+\d{1,5}\s+R/.test(this.raw);
  }

  private scanObjects(): void {
    const pattern = /(?<=[\s>\]])(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
    let match = pattern.exec(this.raw);
    while (match !== null && this.objects.size < MAX_OBJECTS) {
      const num = Number.parseInt(match[1] ?? '', 10);
      const start = match.index + match[0].length;
      const endObj = this.raw.indexOf('endobj', start);
      const end = endObj === -1 ? this.raw.length : endObj;
      this.objects.set(num, { dict: this.raw.slice(start, end), start, end });
      match = pattern.exec(this.raw);
    }
  }

  private expandObjectStreams(): void {
    for (const [num, object] of Array.from(this.objects)) {
      if (dictValue(object.dict, 'Type') !== '/ObjStm') continue;
      const decoded = this.streamBytes(num);
      if (decoded === undefined) continue;
      const count = dictNumber(dictValue(object.dict, 'N'));
      const first = dictNumber(dictValue(object.dict, 'First'));
      if (count === undefined || first === undefined) continue;
      const header = decodeLatin1(decoded.subarray(0, Math.min(decoded.length, first)));
      const numbers = header.match(/\d+/g);
      if (numbers === null) continue;
      const total = Math.min(Math.floor(numbers.length / 2), Math.floor(count));
      for (let i = 0; i < total; i += 1) {
        const target = Number.parseInt(numbers[i * 2] ?? '', 10);
        const offset = Number.parseInt(numbers[i * 2 + 1] ?? '', 10);
        if (Number.isNaN(target) || Number.isNaN(offset)) continue;
        if (this.objects.has(target)) continue;
        const from = first + offset;
        if (from < 0 || from >= decoded.length) continue;
        const stop = this.findObjectEnd(decoded, from);
        this.objects.set(target, {
          dict: decodeLatin1(decoded.subarray(from, stop)),
          start: -1,
          end: -1,
        });
      }
    }
  }

  private findObjectEnd(data: Uint8Array, from: number): number {
    const text = decodeLatin1(data.subarray(from, Math.min(data.length, from + 65_536)));
    const match = /(?:\s|^)(?:endobj|endstream)\b/.exec(text);
    return match === null ? data.length : from + match.index;
  }

  private streamBytes(num: number): Uint8Array | undefined {
    const object = this.objects.get(num);
    if (object === undefined || object.start < 0) return undefined;
    if (this.decoded.has(num)) return undefined;
    this.decoded.add(num);
    const keyword = object.dict.indexOf('stream');
    if (keyword === -1) return undefined;
    let start = object.start + keyword + 'stream'.length;
    if (this.raw[start] === '\r') start += 1;
    if (this.raw[start] === '\n') start += 1;
    const declared = dictNumber(dictValue(object.dict, 'Length'));
    const lengthRef = /\/Length\s+(\d{1,10})\s+\d{1,5}\s+R/.exec(object.dict);
    let end = start + (declared ?? 0);
    if (declared === undefined || end > object.end) {
      const found = this.raw.indexOf('endstream', start);
      if (found === -1) return undefined;
      end = found;
      while (end > start && (this.raw[end - 1] === '\n' || this.raw[end - 1] === '\r')) end -= 1;
    }
    if (lengthRef !== null) {
      const refDict = this.objects.get(Number.parseInt(lengthRef[1] ?? '', 10))?.dict;
      const resolved = refDict === undefined ? undefined : Number.parseInt(refDict.trim(), 10);
      if (resolved !== undefined && Number.isFinite(resolved) && resolved > 0 && start + resolved <= object.end) {
        end = start + resolved;
      }
    }
    const size = end - start;
    if (size <= 0 || size > MAX_STREAM_BYTES) return undefined;
    let data = this.bytes.subarray(start, end);
    for (const filter of dictNames(dictValue(object.dict, 'Filter')).reverse()) {
      if (filter === 'FlateDecode' || filter === 'Fl') {
        data = inflate(data);
      } else if (filter === 'ASCIIHexDecode' || filter === 'AHx') {
        data = decodeAsciiHex(decodeLatin1(data));
      } else if (filter === 'ASCII85Decode' || filter === 'A85') {
        const ascii85 = decodeAscii85(decodeLatin1(data));
        if (ascii85 === undefined) return undefined;
        data = ascii85;
      } else {
        return undefined;
      }
    }
    return data;
  }

  cmapFor(ref: number): CMap | undefined {
    const cached = this.cmapCache.get(ref);
    if (cached !== undefined) return cached ?? undefined;
    const object = this.objects.get(ref);
    if (object === undefined) {
      this.cmapCache.set(ref, null);
      return undefined;
    }
    const target = dictRefs(dictValue(object.dict, 'ToUnicode'))[0];
    let result: CMap | null = null;
    if (target !== undefined) {
      const data = this.streamBytes(target);
      if (data !== undefined) result = parseToUnicode(decodeLatin1(data)) ?? null;
    }
    this.cmapCache.set(ref, result);
    return result ?? undefined;
  }

  pageRefs(): number[] {
    const roots: number[] = [];
    for (const [num, object] of this.objects) {
      const type = dictValue(object.dict, 'Type');
      if (type === '/Catalog') roots.push(...dictRefs(dictValue(object.dict, 'Pages')));
      if (type === '/Pages') roots.push(num);
    }
    const ordered: number[] = [];
    const seen = new Set<number>();
    const visit = (num: number, depth: number): void => {
      if (seen.has(num) || depth > 64 || ordered.length >= MAX_PAGES) return;
      seen.add(num);
      const object = this.objects.get(num);
      if (object === undefined) return;
      if (dictValue(object.dict, 'Type') === '/Page') {
        ordered.push(num);
        return;
      }
      for (const kid of dictRefs(dictValue(object.dict, 'Kids'))) visit(kid, depth + 1);
    };
    for (const root of roots) visit(root, 0);
    if (ordered.length > 0) return ordered;
    for (const [num, object] of this.objects) {
      if (dictValue(object.dict, 'Type') === '/Page') ordered.push(num);
    }
    return ordered.slice(0, MAX_PAGES);
  }

  fontCmaps(pageNum: number): Map<string, CMap> {
    const result = new Map<string, CMap>();
    const page = this.objects.get(pageNum);
    if (page === undefined) return result;
    const resources = dictValue(page.dict, 'Resources') ?? this.inheritedResources(pageNum) ?? '';
    for (const [name, ref] of this.namedEntries(dictValue(resources, 'Font') ?? '')) {
      const cmap = this.cmapFor(ref);
      if (cmap !== undefined) result.set(name, cmap);
    }
    return result;
  }

  private inheritedResources(pageNum: number): string | undefined {
    let cursor: number | undefined = pageNum;
    for (let depth = 0; depth < 32; depth += 1) {
      if (cursor === undefined) return undefined;
      const object = this.objects.get(cursor);
      if (object === undefined) return undefined;
      const own = dictValue(object.dict, 'Resources');
      if (own !== undefined && own.length > 0) return own;
      cursor = dictRefs(dictValue(object.dict, 'Parent'))[0];
    }
    return undefined;
  }

  private namedEntries(dict: string): [string, number][] {
    const entries: [string, number][] = [];
    const pattern = /\/([^\s/[\]<>(){}%]+)\s+(\d{1,10})\s+\d{1,5}\s+R\b/g;
    let match = pattern.exec(dict);
    while (match !== null) {
      entries.push([match[1] ?? '', Number.parseInt(match[2] ?? '', 10)]);
      match = pattern.exec(dict);
    }
    return entries;
  }

  contentStreams(pageNum: number): string[] {
    const page = this.objects.get(pageNum);
    if (page === undefined) return [];
    const streams: string[] = [];
    for (const ref of dictRefs(dictValue(page.dict, 'Contents'))) {
      const data = this.streamBytes(ref);
      if (data === undefined) continue;
      const text = decodeLatin1(data);
      if (text.includes('Tj') || text.includes('TJ')) streams.push(text);
    }
    return streams;
  }
}

interface TextState {
  readonly out: string[];
  line: string[];
  lastY: number | undefined;
  leading: number;
  font: string;
  chars: number;
}

export function extractPdfText(bytes: Uint8Array): string | undefined {
  const head = decodeLatin1(bytes.subarray(0, Math.min(bytes.length, 1024)));
  if (!head.includes('%PDF-')) return undefined;
  let doc: PdfDocument;
  try {
    doc = new PdfDocument(bytes);
  } catch {
    return undefined;
  }
  if (doc.encrypted) return undefined;
  const pages = doc.pageRefs();
  if (pages.length === 0) return undefined;
  const state: TextState = {
    out: [],
    line: [],
    lastY: undefined,
    leading: 12,
    font: '',
    chars: 0,
  };
  const cmaps = new Map<number, Map<string, CMap>>();

  const flush = (): void => {
    if (state.line.length === 0) return;
    state.out.push(state.line.join(''));
    state.line = [];
  };
  const newline = (): void => {
    flush();
  };
  const emit = (text: string): void => {
    if (text.length === 0) return;
    state.line.push(text);
    state.chars += text.length;
  };
  const emitSpacer = (): void => {
    const tail = state.line[state.line.length - 1];
    if (tail === undefined || tail.length === 0) return;
    if (/\s$/.test(tail)) return;
    state.line.push(' ');
    state.chars += 1;
  };

  for (const pageNum of pages) {
    if (state.chars >= MAX_OUTPUT_CHARS) break;
    let pageCmaps = cmaps.get(pageNum);
    if (pageCmaps === undefined) {
      pageCmaps = doc.fontCmaps(pageNum);
      cmaps.set(pageNum, pageCmaps);
    }
    for (const stream of doc.contentStreams(pageNum)) {
      if (state.chars >= MAX_OUTPUT_CHARS) break;
      runContentStream(stream, pageCmaps, state, emit, emitSpacer, newline);
    }
    flush();
  }
  flush();
  return tidy(state.out.join('\n'));
}

function runContentStream(
  src: string,
  cmaps: ReadonlyMap<string, CMap>,
  state: TextState,
  emit: (text: string) => void,
  emitSpacer: () => void,
  newline: () => void,
): void {
  const tokens = tokenizePdf(src, MAX_TOKENS);
  const operands: PdfToken[] = [];
  let inText = false;
  let textDirty = false;
  const numbers = (): number[] =>
    operands.filter((item): item is Extract<PdfToken, { kind: 'num' }> => item.kind === 'num').map(
      (item) => item.value,
    );

  for (const token of tokens) {
    if (token.kind !== 'op') {
      if (inText) {
        if (operands.length >= 32) operands.shift();
        operands.push(token);
      }
      continue;
    }
    const op = token.value;
    if (op === 'BT') {
      inText = true;
      textDirty = true;
      state.lastY = undefined;
      operands.length = 0;
      continue;
    }
    if (op === 'ET') {
      if (inText && textDirty) newline();
      inText = false;
      textDirty = false;
      operands.length = 0;
      continue;
    }
    if (!inText) continue;
    switch (op) {
      case 'Tf': {
        const name = operands.findLast(
          (item): item is Extract<PdfToken, { kind: 'name' }> => item.kind === 'name',
        );
        if (name !== undefined) state.font = name.value;
        break;
      }
      case 'Tj':
      case "'":
      case '"': {
        if (op !== 'Tj') newline();
        const text = operands.findLast(
          (item): item is Extract<PdfToken, { kind: 'str' }> => item.kind === 'str',
        );
        if (text !== undefined) {
          emit(decodePdfBytes(text.bytes, cmaps.get(state.font)));
          textDirty = true;
        }
        break;
      }
      case 'TJ': {
        for (const item of operands) {
          if (item.kind === 'str') {
            emit(decodePdfBytes(item.bytes, cmaps.get(state.font)));
            textDirty = true;
          } else if (item.kind === 'num' && item.value <= WORD_SPACE_THRESHOLD) {
            emitSpacer();
          }
        }
        break;
      }
      case 'Td':
      case 'TD': {
        const values = numbers();
        const ty = values[values.length - 1] ?? 0;
        if (op === 'TD') state.leading = -ty;
        if (ty !== 0) newline();
        state.lastY = ty;
        break;
      }
      case 'Tm': {
        const values = numbers();
        const ty = values[values.length - 1] ?? 0;
        if (state.lastY !== undefined && Math.abs(ty - state.lastY) > POSITION_EPSILON) newline();
        state.lastY = ty;
        break;
      }
      case 'TL': {
        state.leading = -(numbers()[numbers().length - 1] ?? state.leading);
        break;
      }
      case 'T*': {
        newline();
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }
}

function tidy(raw: string): string | undefined {
  const cleaned = raw
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+$/g, '').replace(/[^\S\n]{3,}/g, '  '));
  const lines: string[] = [];
  for (const line of cleaned) {
    const previous = lines[lines.length - 1];
    if (line.length === 0 && (previous === undefined || previous.length === 0)) continue;
    lines.push(line);
  }
  const text = lines.join('\n').trim();
  return text.length === 0 ? undefined : text;
}
