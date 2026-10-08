import { deflateSync } from 'node:zlib';

import { ZipFile } from 'yazl';
import { describe, expect, it } from 'vitest';

import { extractDocument, extractableFormat } from '#/agent/tools/os/read/extract/extract';
import { extractPdfText } from '#/agent/tools/os/read/extract/pdf';
import { extractRtfText } from '#/agent/tools/os/read/extract/rtf';

function zipBuffer(files: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    for (const [name, content] of Object.entries(files)) {
      zip.addBuffer(Buffer.from(content, 'utf8'), name);
    }
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    zip.outputStream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    zip.outputStream.on('error', reject);
  });
}

function pdfEscape(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function textPdf(lines: readonly string[]): Buffer {
  const body = [
    'BT',
    '/F1 12 Tf',
    '72 720 Td',
    ...lines.map((line, index) => `(${pdfEscape(line)}) Tj${index < lines.length - 1 ? ' T*' : ''}`),
    'ET',
  ].join('\n');
  const compressed = deflateSync(Buffer.from(body, 'latin1'));
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n', 'latin1')];
  const push = (body2: string): void => {
    parts.push(Buffer.from(body2, 'latin1'));
  };
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  push(
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
  );
  parts.push(
    Buffer.concat([
      Buffer.from(
        `4 0 obj\n<< /Length ${String(compressed.length)} /Filter /FlateDecode >>\nstream\n`,
        'latin1',
      ),
      compressed,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    ]),
  );
  push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  push('trailer\n<< /Size 6 /Root 1 0 R >>\n%%EOF\n');
  return Buffer.concat(parts);
}

describe('extractableFormat', () => {
  it('maps known document suffixes to a format', () => {
    expect(extractableFormat('report.pdf')).toBe('pdf');
    expect(extractableFormat('REPORT.PDF')).toBe('pdf');
    expect(extractableFormat('memo.docx')).toBe('docx');
    expect(extractableFormat('book.xlsm')).toBe('xlsx');
    expect(extractableFormat('deck.pptm')).toBe('pptx');
    expect(extractableFormat('notes.odt')).toBe('odf');
    expect(extractableFormat('novel.epub')).toBe('epub');
    expect(extractableFormat('memo.rtf')).toBe('rtf');
  });

  it('returns undefined for anything else', () => {
    expect(extractableFormat('main.ts')).toBeUndefined();
    expect(extractableFormat('legacy.doc')).toBeUndefined();
    expect(extractableFormat('legacy.xls')).toBeUndefined();
    expect(extractableFormat('Makefile')).toBeUndefined();
    expect(extractableFormat('archive.zip')).toBeUndefined();
  });
});

describe('extractPdfText', () => {
  it('extracts a FlateDecode text layer line by line', () => {
    const text = extractPdfText(textPdf(['First line', 'Second line', 'Third line']));

    expect(text).toBe('First line\nSecond line\nThird line');
  });

  it('returns undefined for a scanned document with no text operators', () => {
    const body = deflateSync(Buffer.from('q 612 0 0 792 0 0 cm /Im0 Do Q', 'latin1'));
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', 'latin1'),
      Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', 'latin1'),
      Buffer.from(
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>\nendobj\n',
        'latin1',
      ),
      Buffer.from(`4 0 obj\n<< /Length ${String(body.length)} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
      body,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
      Buffer.from('5 0 obj\n<< /Type /XObject /Subtype /Image >>\nendobj\n', 'latin1'),
      Buffer.from('trailer\n<< /Size 6 /Root 1 0 R >>\n%%EOF\n', 'latin1'),
    ]);

    expect(extractPdfText(pdf)).toBeUndefined();
  });

  it('returns undefined for an encrypted document', () => {
    const pdf = textPdf(['secret']);

    const encrypted = Buffer.concat([pdf, Buffer.from('\n9 0 obj\n<< /Filter /Standard >>\nendobj\n', 'latin1')])
      .toString('latin1')
      .replace('trailer\n<< /Size 6 /Root 1 0 R >>', 'trailer\n<< /Size 6 /Root 1 0 R /Encrypt 9 0 R >>');
    const buffer = Buffer.from(encrypted, 'latin1');

    expect(extractPdfText(buffer)).toBeUndefined();
  });

  it('returns undefined when the bytes are not a PDF at all', () => {
    expect(extractPdfText(Buffer.from('not a pdf', 'utf8'))).toBeUndefined();
  });

  it('applies a ToUnicode CMap over the raw character codes', () => {
    const cmap = [
      '/CIDInit /ProcSet findresource begin',
      '12 dict begin begincmap',
      '/CMapName /Custom def 1 begincodespacerange',
      '<00> <ff>',
      'endcodespacerange',
      '1 beginbfchar',
      '<41> <03A9>',
      'endbfchar',
      'endcmap CMapName currentdict /CMap defineresource pop end end',
    ].join('\n');
    const compressed = deflateSync(Buffer.from(cmap, 'latin1'));
    const content = deflateSync(Buffer.from('BT /F1 12 Tf 72 720 Td (A) Tj ET', 'latin1'));
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.7\n', 'latin1'),
      Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', 'latin1'),
      Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', 'latin1'),
      Buffer.from(
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
        'latin1',
      ),
      Buffer.from(`4 0 obj\n<< /Length ${String(content.length)} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
      content,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
      Buffer.from(
        `5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>\nendobj\n`,
        'latin1',
      ),
      Buffer.from(`6 0 obj\n<< /Length ${String(compressed.length)} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
      compressed,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
      Buffer.from('trailer\n<< /Size 7 /Root 1 0 R >>\n%%EOF\n', 'latin1'),
    ]);

    expect(extractPdfText(pdf)).toBe('Ω');
  });
});

describe('extractDocument', () => {
  it('extracts docx paragraphs and unescapes entities', async () => {
    const bytes = await zipBuffer({
      'word/document.xml':
        '<?xml version="1.0"?><w:document><w:body>' +
        '<w:p><w:r><w:t>Hello</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t xml:space="preserve">A &amp; B</w:t></w:r><w:r><w:tab/><w:t>tail</w:t></w:r></w:p>' +
        '</w:body></w:document>',
    });

    const result = await extractDocument('memo.docx', bytes);

    expect(result?.format).toBe('docx');
    expect(result?.text).toBe('Hello\nA & B\ttail');
  });

  it('resolves shared strings and joins xlsx cells with tabs', async () => {
    const bytes = await zipBuffer({
      'xl/sharedStrings.xml':
        '<sst><si><t>Name</t></si><si><r><t>Ki</t></r><t>mi</t></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData>' +
        '<row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row><c r="A2" t="inlineStr"><is><t>inline</t></is></c><c r="B2"><v>42</v></c></row>' +
        '<row><c r="A3" t="b"><v>1</v></c></row>' +
        '</sheetData></worksheet>',
    });

    const result = await extractDocument('sheet.xlsx', bytes);

    expect(result?.format).toBe('xlsx');
    expect(result?.text).toBe('## 1\nName\tKimi\ninline\t42\nTRUE');
  });

  it('orders pptx slides numerically and labels them', async () => {
    const bytes = await zipBuffer({
      'ppt/slides/slide1.xml': '<p:sld><p:cSld><a:p><a:r><a:t>Opening</a:t></a:r></a:p></p:cSld></p:sld>',
      'ppt/slides/slide2.xml': '<p:sld><p:cSld><a:p><a:r><a:t>Closing</a:t></a:r></a:p></p:cSld></p:sld>',
      'ppt/slides/slide10.xml': '<p:sld><p:cSld><a:p><a:r><a:t>Appendix</a:t></a:r></a:p></p:cSld></p:sld>',
    });

    const result = await extractDocument('deck.pptx', bytes);

    expect(result?.text).toBe(
      '## Slide 1\nOpening\n\n## Slide 2\nClosing\n\n## Slide 3\nAppendix',
    );
  });

  it('extracts OpenDocument content.xml', async () => {
    const bytes = await zipBuffer({
      'content.xml':
        '<office:document-content>' +
        '<office:automatic-styles><style:style style:name="x"/></office:automatic-styles>' +
        '<office:body><office:text><text:h>Title</text:h><text:p>Body text</text:p></office:text></office:body>' +
        '</office:document-content>',
    });

    const result = await extractDocument('notes.odt', bytes);

    expect(result?.format).toBe('odf');
    expect(result?.text).toBe('Title\nBody text');
  });

  it('follows the epub container to its html documents', async () => {
    const bytes = await zipBuffer({
      'META-INF/container.xml':
        '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
      'OEBPS/content.opf':
        '<package><manifest>' +
        '<item href="chapter1.xhtml" media-type="application/xhtml+xml"/>' +
        '<item href="cover.png" media-type="image/png"/>' +
        '</manifest></package>',
      'OEBPS/chapter1.xhtml': '<html><body><h1>Chapter</h1><p>Once upon a time</p></body></html>',
    });

    const result = await extractDocument('novel.epub', bytes);

    expect(result?.format).toBe('epub');
    expect(result?.text).toBe('## 1\nChapter\nOnce upon a time');
  });

  it('returns undefined for a corrupt archive instead of throwing', async () => {
    const result = await extractDocument('broken.docx', Buffer.from('PK not really', 'utf8'));

    expect(result).toBeUndefined();
  });

  it('returns undefined for an unsupported suffix', async () => {
    const result = await extractDocument('notes.txt', Buffer.from('plain', 'utf8'));

    expect(result).toBeUndefined();
  });
});

describe('extractRtfText', () => {
  it('keeps paragraph breaks and unicode escapes, dropping destinations', () => {
    const rtf =
      '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Helvetica;}}' +
      '\\f0\\fs24 First \\u9731? paragraph.\\par ' +
      'Second line\\tab tabbed.\\par}';

    expect(extractRtfText(rtf)).toBe('First ☃ paragraph.\nSecond line\ttabbed.');
  });

  it('returns undefined when the RTF header is missing', () => {
    expect(extractRtfText('just text')).toBeUndefined();
  });
});