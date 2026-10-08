import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const DOCUMENT_EXTRACT_FLAG_ID = 'document_extract';
export const DOCUMENT_EXTRACT_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_DOCUMENT_EXTRACT';

export const documentExtractFlag: FlagDefinitionInput = {
  id: DOCUMENT_EXTRACT_FLAG_ID,
  title: 'Read documents',
  description:
    'Let the Read tool extract text from PDF, Word, Excel, PowerPoint, OpenDocument and EPUB files instead of refusing them as unreadable.',
  env: DOCUMENT_EXTRACT_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(documentExtractFlag);
