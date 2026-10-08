import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const FILE_RESTORE_FLAG_ID = 'file_restore';
export const FILE_RESTORE_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_FILE_RESTORE';

export const fileRestoreFlag: FlagDefinitionInput = {
  id: FILE_RESTORE_FLAG_ID,
  title: 'Restore files from a turn',
  description:
    'Add a RestoreFile tool that puts files back the way they were at the start of an earlier turn, instead of only reporting what changed.',
  env: FILE_RESTORE_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(fileRestoreFlag);