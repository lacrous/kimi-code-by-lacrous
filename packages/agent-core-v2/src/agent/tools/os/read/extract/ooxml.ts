import { type Entry, fromBuffer as yauzlFromBuffer } from 'yauzl';

const MAX_ENTRIES = 20_000;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 8_000_000;

interface TagPolicy {
  readonly breaks: ReadonlySet<string>;
  readonly lineBreaks: ReadonlySet<string>;
  readonly tabs: ReadonlySet<string>;
  readonly skips: ReadonlySet<string>;
  readonly carriers: ReadonlySet<string> | undefined;
  readonly transform?: (text: string) => string;
}

interface Tag {
  readonly name: string;
  readonly closing: boolean;
  readonly literalEnd: number;
}

function fromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

const XML_ENTITY_RE =
  /&(?:amp|lt|gt|quot|apos|#\d{1,8}|#x[0-9a-fA-F]{1,6}|_x[0-9a-fA-F]{4}_);/g;

function unescapeXml(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(XML_ENTITY_RE, (match) => {
    switch (match) {
      case '&amp;':
        return '&';
      case '&lt;':
        return '<';
      case '&gt;':
        return '>';
      case '&quot;':
        return '"';
      case '&apos;':
        return "'";
      default:
        break;
    }
    if (match.startsWith('&#x')) return fromCodePoint(Number.parseInt(match.slice(3, -1), 16));
    if (match.startsWith('&#')) return fromCodePoint(Number.parseInt(match.slice(2, -1), 10));
    return String.fromCharCode(Number.parseInt(match.slice(2, -2), 16));
  });
}

function readTag(xml: string, start: number): { tag: Tag | undefined; next: number } {
  if (xml.startsWith('<!--', start)) {
    const end = xml.indexOf('-->', start);
    return { tag: undefined, next: end === -1 ? xml.length : end + 3 };
  }
  if (xml.startsWith('<![CDATA[', start)) {
    const end = xml.indexOf(']]>', start);
    return {
      tag: { name: '', closing: false, literalEnd: end === -1 ? xml.length : end },
      next: end === -1 ? xml.length : end + 3,
    };
  }
  if (xml.startsWith('<?', start) || xml.startsWith('<!', start)) {
    const end = xml.indexOf('>', start);
    return { tag: undefined, next: end === -1 ? xml.length : end + 1 };
  }
  let i = start + 1;
  const closing = xml[i] === '/';
  if (closing) i += 1;
  const nameStart = i;
  while (i < xml.length) {
    const ch = xml[i];
    if (
      ch === undefined ||
      ch === ' ' ||
      ch === '\t' ||
      ch === '\n' ||
      ch === '\r' ||
      ch === '>' ||
      (ch === '/' && xml[i + 1] === '>')
    ) {
      break;
    }
    i += 1;
  }
  const name = xml.slice(nameStart, i);
  if (name.length === 0) return { tag: undefined, next: start + 1 };
  let depth = 0;
  let inQuote: string | undefined;
  for (; i < xml.length; i += 1) {
    const ch = xml[i];
    if (inQuote !== undefined) {
      if (ch === inQuote) inQuote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") inQuote = ch;
    else if (ch === '<') depth += 1;
    else if (ch === '>') {
      if (depth === 0) return { tag: { name, closing, literalEnd: -1 }, next: i + 1 };
      depth -= 1;
    }
  }
  return { tag: { name, closing, literalEnd: -1 }, next: xml.length };
}

function extractXmlText(xml: string, policy: TagPolicy): string {
  const parts: string[] = [];
  let chars = 0;
  let i = 0;
  let skipName: string | undefined;
  let skipDepth = 0;
  let carrierDepth = 0;

  const push = (text: string): void => {
    if (text.length === 0 || chars >= MAX_OUTPUT_CHARS) return;
    parts.push(text);
    chars += text.length;
  };
  const pushText = (raw: string, literal: boolean): void => {
    if (skipName !== undefined) return;
    if (policy.carriers !== undefined && carrierDepth === 0) return;
    const text = literal ? raw : unescapeXml(raw);
    push(policy.transform === undefined ? text : policy.transform(text));
  };

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      pushText(xml.slice(i), false);
      break;
    }
    if (lt > i) pushText(xml.slice(i, lt), false);
    const read = readTag(xml, lt);
    i = read.next;
    const tag = read.tag;
    if (tag === undefined) continue;
    if (tag.literalEnd >= 0) {
      pushText(xml.slice(lt + '<![CDATA['.length, tag.literalEnd), true);
      continue;
    }
    if (policy.skips.has(tag.name)) {
      if (tag.closing) {
        if (skipName === tag.name) {
          skipDepth -= 1;
          if (skipDepth <= 0) {
            skipName = undefined;
            skipDepth = 0;
          }
        }
      } else if (skipName === undefined || skipName === tag.name) {
        skipName = tag.name;
        skipDepth += 1;
      }
      continue;
    }
    if (policy.carriers?.has(tag.name) === true) {
      if (tag.closing) carrierDepth = Math.max(0, carrierDepth - 1);
      else carrierDepth += 1;
      continue;
    }
    if (tag.closing) {
      if (policy.breaks.has(tag.name)) push('\n');
      continue;
    }
    if (policy.tabs.has(tag.name)) push('\t');
    if (policy.lineBreaks.has(tag.name)) push('\n');
  }
  return parts.join('');
}

const DOCX_POLICY: TagPolicy = {
  breaks: new Set(['w:p']),
  lineBreaks: new Set(['w:br', 'w:cr']),
  tabs: new Set(['w:tab']),
  skips: new Set(['w:instrText', 'w:delText', 'w:del', 'w:script', 'w:proofErr']),
  carriers: new Set(['w:t']),
  transform: (text) => text.replaceAll('_x000D_', '\n'),
};

const PPTX_POLICY: TagPolicy = {
  breaks: new Set(['a:p']),
  lineBreaks: new Set(['a:br']),
  tabs: new Set(['a:tab']),
  skips: new Set([
    'a:fld',
    'a:extLst',
    'p:extLst',
    'p:bg',
    'p:clrMapOvr',
    'p:transition',
    'p:timing',
    'mc:AlternateContent',
  ]),
  carriers: new Set(['a:t']),
};

const GENERIC_POLICY: TagPolicy = {
  breaks: new Set([
    'text:p',
    'text:h',
    'p',
    'h',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'div',
    'li',
    'tr',
    'title',
  ]),
  lineBreaks: new Set(['text:line-break', 'br', 'hr']),
  tabs: new Set(['text:tab', 'td', 'th']),
  skips: new Set([
    'style',
    'script',
    'head',
    'office:automatic-styles',
    'office:font-face-decls',
    'office:document-meta',
    'number:number-style',
    'number:currency-style',
    'number:percentage-style',
    'number:date-style',
    'number:text-style',
    'style:style',
    'style:page-layout',
    'text:list-style',
    'text:section',
    'text:notes-configuration',
    'text:tracked-changes',
    'svg',
    'image',
  ]),
  carriers: undefined,
};

function decodeEntryText(buffer: Buffer): string {
  const text = buffer.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readAllEntries(buffer: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const collected = new Map<string, Buffer>();
    let total = 0;
    let settled = false;
    yauzlFromBuffer(buffer, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr !== null || zipfile === undefined) {
        reject(new Error(openErr?.message ?? 'cannot read archive'));
        return;
      }
      const finish = (): void => {
        if (settled) return;
        settled = true;
        zipfile.close();
        resolve(collected);
      };
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        zipfile.close();
        reject(err);
      };
      zipfile.on('entry', (entry: Entry) => {
        if (entry.fileName.endsWith('/')) {
          zipfile.readEntry();
          return;
        }
        if (collected.size >= MAX_ENTRIES) {
          finish();
          return;
        }
        const size = entry.uncompressedSize;
        if (size > MAX_ENTRY_BYTES || total + size > MAX_TOTAL_BYTES) {
          finish();
          return;
        }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr !== null || stream === undefined) {
            fail(new Error(streamErr?.message ?? `cannot read ${entry.fileName}`));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', fail);
          stream.on('end', () => {
            total += size;
            collected.set(entry.fileName, Buffer.concat(chunks));
            zipfile.readEntry();
          });
        });
      });
      zipfile.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(collected);
      });
      zipfile.on('error', fail);
      zipfile.readEntry();
    });
  });
}

function numericOrder(names: readonly string[], prefix: string): string[] {
  return [...names]
    .filter((name) => name.startsWith(prefix))
    .sort((a, b) => {
      const left = Number.parseInt(/(\d+)(?=[^0-9]*$)/.exec(a.slice(prefix.length))?.[1] ?? '', 10);
      const right = Number.parseInt(/(\d+)(?=[^0-9]*$)/.exec(b.slice(prefix.length))?.[1] ?? '', 10);
      if (Number.isNaN(left) || Number.isNaN(right)) return a.localeCompare(b);
      return left - right;
    });
}

function extractDocx(entries: ReadonlyMap<string, Buffer>): string | undefined {
  const body = entries.get('word/document.xml');
  if (body === undefined) return undefined;
  return extractXmlText(decodeEntryText(body), DOCX_POLICY);
}

function extractPptx(entries: ReadonlyMap<string, Buffer>): string | undefined {
  const slides = numericOrder([...entries.keys()], 'ppt/slides/slide');
  const parts: string[] = [];
  for (const name of slides) {
    if (!name.endsWith('.xml')) continue;
    const body = entries.get(name);
    if (body === undefined) continue;
    const text = extractXmlText(decodeEntryText(body), PPTX_POLICY);
    if (text.trim().length === 0) continue;
    parts.push(`## Slide ${parts.length + 1}\n${text.trim()}`);
  }
  return parts.length === 0 ? undefined : parts.join('\n\n');
}

function extractSharedStrings(entries: ReadonlyMap<string, Buffer>): string[] {
  const body = entries.get('xl/sharedStrings.xml');
  if (body === undefined) return [];
  const xml = decodeEntryText(body);
  const strings: string[] = [];
  const pattern = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match = pattern.exec(xml);
  while (match !== null) {
    strings.push(extractXmlText(match[1] ?? '', {
      breaks: new Set(),
      lineBreaks: new Set(['a:br', 'br', 'text:line-break']),
      tabs: new Set(['text:tab']),
      skips: new Set(['rPh', 'phoneticPr']),
      carriers: undefined,
    }));
    match = pattern.exec(xml);
  }
  return strings;
}

const CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
const ROW_RE = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
const VALUE_RE = /<v\b[^>]*>([\s\S]*?)<\/v>/;
const INLINE_RE = /<t\b[^>]*>([\s\S]*?)<\/t>/g;

function cellText(attrs: string, body: string, shared: readonly string[]): string {
  const typeMatch = /\bt\s*=\s*"([^"]*)"/.exec(attrs);
  const type = typeMatch?.[1] ?? 'n';
  if (type === 'inlineStr') {
    const parts: string[] = [];
    INLINE_RE.lastIndex = 0;
    let inline = INLINE_RE.exec(body);
    while (inline !== null) {
      parts.push(unescapeXml(inline[1] ?? ''));
      inline = INLINE_RE.exec(body);
    }
    return parts.join('');
  }
  const raw = unescapeXml(VALUE_RE.exec(body)?.[1] ?? '').trim();
  if (raw.length === 0) return '';
  if (type === 's') {
    const index = Number.parseInt(raw, 10);
    return Number.isNaN(index) ? '' : (shared[index] ?? '');
  }
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  return raw;
}

function extractXlsx(entries: ReadonlyMap<string, Buffer>): string | undefined {
  const sheets = numericOrder([...entries.keys()], 'xl/worksheets/sheet').filter((name) =>
    name.endsWith('.xml'),
  );
  if (sheets.length === 0) return undefined;
  const shared = extractSharedStrings(entries);
  const parts: string[] = [];
  for (const name of sheets) {
    const body = entries.get(name);
    if (body === undefined) continue;
    const xml = decodeEntryText(body);
    const rows: string[] = [];
    ROW_RE.lastIndex = 0;
    let row = ROW_RE.exec(xml);
    while (row !== null) {
      const cells: string[] = [];
      CELL_RE.lastIndex = 0;
      let cell = CELL_RE.exec(row[2] ?? '');
      while (cell !== null) {
        cells.push(cellText(cell[1] ?? '', cell[2] ?? '', shared));
        cell = CELL_RE.exec(row[2] ?? '');
      }
      rows.push(cells.join('\t').replace(/[^\S\n]+$/g, ''));
      row = ROW_RE.exec(xml);
    }
    if (rows.every((line) => line.trim().length === 0)) continue;
    parts.push(`## ${sheets.indexOf(name) + 1}\n${rows.join('\n')}`);
  }
  return parts.length === 0 ? undefined : parts.join('\n\n');
}

function extractOdf(entries: ReadonlyMap<string, Buffer>): string | undefined {
  const body = entries.get('content.xml');
  if (body === undefined) return undefined;
  const text = extractXmlText(decodeEntryText(body), GENERIC_POLICY);
  return text.trim().length === 0 ? undefined : text;
}

function extractEpub(entries: ReadonlyMap<string, Buffer>): string | undefined {
  const container = entries.get('META-INF/container.xml');
  if (container === undefined) return undefined;
  const rootfile = /full-path\s*=\s*"([^"]+)"/.exec(decodeEntryText(container))?.[1];
  if (rootfile === undefined) return undefined;
  const opf = entries.get(rootfile);
  if (opf === undefined) return undefined;
  const opfDir = rootfile.includes('/') ? `${rootfile.slice(0, rootfile.lastIndexOf('/') + 1)}` : '';
  const opfXml = decodeEntryText(opf);
  const parts: string[] = [];
  const pattern = /<item\b([^>]*)\/?>/g;
  let match = pattern.exec(opfXml);
  let seen = 0;
  while (match !== null) {
    const attrs = match[1] ?? '';
    const media = /media-type\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? '';
    const href = /href\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
    if (href !== undefined && media.includes('html')) {
      seen += 1;
      const target = entries.get(`${opfDir}${decodeURIComponent(href)}`);
      if (target !== undefined) {
        const text = extractXmlText(decodeEntryText(target), GENERIC_POLICY);
        if (text.trim().length > 0) parts.push(`## ${seen}\n${text.trim()}`);
      }
    }
    match = pattern.exec(opfXml);
  }
  return parts.length === 0 ? undefined : parts.join('\n\n');
}

export const ZIP_SUFFIXES = [
  '.docx',
  '.docm',
  '.dotx',
  '.xlsx',
  '.xlsm',
  '.xltx',
  '.pptx',
  '.pptm',
  '.potx',
  '.odt',
  '.odm',
  '.ods',
  '.odp',
  '.otp',
  '.ots',
  '.epub',
] as const;

export function isZipSuffix(suffix: string): boolean {
  return (ZIP_SUFFIXES as readonly string[]).includes(suffix.toLowerCase());
}

export async function extractZipDocument(suffix: string, bytes: Uint8Array): Promise<string | undefined> {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let entries: Map<string, Buffer>;
  try {
    entries = await readAllEntries(buffer);
  } catch {
    return undefined;
  }
  if (entries.size === 0) return undefined;
  switch (suffix.toLowerCase()) {
    case '.docx':
    case '.docm':
    case '.dotx':
      return extractDocx(entries);
    case '.xlsx':
    case '.xlsm':
    case '.xltx':
      return extractXlsx(entries);
    case '.pptx':
    case '.pptm':
    case '.potx':
      return extractPptx(entries);
    case '.odt':
    case '.odm':
    case '.ods':
    case '.odp':
    case '.otp':
    case '.ots':
      return extractOdf(entries);
    case '.epub':
      return extractEpub(entries);
    default:
      return undefined;
  }
}
