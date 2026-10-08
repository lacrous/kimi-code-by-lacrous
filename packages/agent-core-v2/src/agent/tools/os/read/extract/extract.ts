import { extractPdfText } from './pdf';
import { extractZipDocument, isZipSuffix } from './ooxml';
import { extractRtfText } from './rtf';

export type DocumentFormat = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'odf' | 'epub' | 'rtf';

export interface DocumentExtraction {
  readonly format: DocumentFormat;
  readonly text: string;
}

const ODF_SUFFIXES = new Set(['.odt', '.odm', '.ods', '.odp', '.otp', '.ots']);

export const DOCUMENT_EXTRACT_MAX_BYTES = 32 * 1024 * 1024;

export const EXTRACTABLE_SUFFIXES = [
  '.pdf',
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
  '.rtf',
];

export function extractableFormat(name: string): DocumentFormat | undefined {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return undefined;
  const suffix = lower.slice(dot);
  if (suffix === '.pdf') return 'pdf';
  if (suffix === '.rtf') return 'rtf';
  if (suffix === '.epub') return 'epub';
  if (ODF_SUFFIXES.has(suffix)) return 'odf';
  if (!isZipSuffix(suffix)) return undefined;
  if (suffix.startsWith('.xls')) return 'xlsx';
  if (suffix.startsWith('.ppt') || suffix.startsWith('.pot')) return 'pptx';
  return 'docx';
}

function tidyText(raw: string): string | undefined {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[^\S\n]+$/g, ''));
  const kept: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (line.length === 0) {
      blanks += 1;
      if (blanks === 1) kept.push('');
      continue;
    }
    blanks = 0;
    kept.push(line);
  }
  const text = kept.join('\n').trim();
  return text.length === 0 ? undefined : text;
}

function toLatin1(bytes: Uint8Array): string {
  let out = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return out;
}

export async function extractDocument(
  name: string,
  bytes: Uint8Array,
): Promise<DocumentExtraction | undefined> {
  const format = extractableFormat(name);
  if (format === undefined) return undefined;
  let raw: string | undefined;
  if (format === 'pdf') {
    raw = extractPdfText(bytes);
  } else if (format === 'rtf') {
    raw = extractRtfText(toLatin1(bytes));
  } else {
    const dot = name.lastIndexOf('.');
    raw = await extractZipDocument(name.slice(dot), bytes);
  }
  if (raw === undefined) return undefined;
  const text = tidyText(raw);
  return text === undefined ? undefined : { format, text };
}
