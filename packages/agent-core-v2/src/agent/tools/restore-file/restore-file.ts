import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const RestoreFileInputSchema = z.object({
  turn_id: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Turn to rewind. Defaults to the most recent turn that changed files. Turn ids come from the user or from a previous RestoreFile result.',
    ),
  paths: z
    .array(z.string())
    .optional()
    .describe(
      'Files to restore. Accepts absolute paths, or paths relative to the current working directory. Defaults to every file the turn changed.',
    ),
  force: z
    .boolean()
    .optional()
    .describe(
      'Overwrite files that changed after the turn ended. Defaults to false, which reports those paths as conflicts and leaves them alone.',
    ),
});

export type RestoreFileInput = z.infer<typeof RestoreFileInputSchema>;

export interface IRestoreFileTool extends AgentTool<RestoreFileInput> {
  readonly _serviceBrand: undefined;
}
export const IRestoreFileTool = createDecorator<IRestoreFileTool>('restoreFileTool');