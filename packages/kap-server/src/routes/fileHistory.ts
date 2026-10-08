import {
  IAgentFileHistoryService,
  resumeSessionById,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { IFlagService } from '@moonshot-ai/agent-core-v2/app/flag/flag';
import { FILE_RESTORE_FLAG_ID } from '@moonshot-ai/agent-core-v2/agent/tools/restore-file/flag';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  fileHistoryChangesQuerySchema,
  fileHistoryChangesResponseSchema,
  fileHistoryContentQuerySchema,
  fileHistoryContentResponseSchema,
  fileHistoryRestoreRequestSchema,
  fileHistoryRestoreResponseSchema,
  fileHistoryTurnsResponseSchema,
} from '../protocol/rest-file-history';
import { ensureMainAgent } from '../transport/mainAgent';

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const RESTORE_DISABLED_MESSAGE =
  'File restore is disabled. Enable the file_restore experimental flag ' +
  `(KIMI_CODE_EXPERIMENTAL_FILE_RESTORE=1) to list restorable turns or restore files.`;

interface FileHistoryRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerFileHistoryRoutes(app: FileHistoryRouteHost, core: Scope): void {
  const changesRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/file-history/changes',
      params: sessionIdParamSchema,
      querystring: fileHistoryChangesQuerySchema,
      success: { data: fileHistoryChangesResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: "List one turn's file changes from the turn-level file history",
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const session = await resumeSessionById(core.accessor, session_id);
      if (session === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const agent = await ensureMainAgent(session);
      const history = agent.accessor.get(IAgentFileHistoryService);
      reply.send(
        okEnvelope(
          {
            changes: await history.changes(req.query.turn_id),
            recorded: await history.turnRecorded(req.query.turn_id),
          },
          req.id,
        ),
      );
    },
  );
  app.get(
    changesRoute.path,
    changesRoute.options,
    changesRoute.handler as Parameters<FileHistoryRouteHost['get']>[2],
  );

  const contentRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/file-history/content',
      params: sessionIdParamSchema,
      querystring: fileHistoryContentQuerySchema,
      success: { data: fileHistoryContentResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: "A file's content as captured at a turn's file-history checkpoint",
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const session = await resumeSessionById(core.accessor, session_id);
      if (session === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const agent = await ensureMainAgent(session);
      const history = agent.accessor.get(IAgentFileHistoryService);
      const content = await history.contentAt(req.query.turn_id, req.query.path, req.query.phase);
      reply.send(okEnvelope({ content: content ?? null }, req.id));
    },
  );
  app.get(
    contentRoute.path,
    contentRoute.options,
    contentRoute.handler as Parameters<FileHistoryRouteHost['get']>[2],
  );

  const turnsRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/file-history/turns',
      params: sessionIdParamSchema,
      success: { data: fileHistoryTurnsResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.CAPABILITY_UNSUPPORTED]: {},
      },
      description: 'List the turns whose file changes can still be restored, newest first',
      operationId: 'listFileChanges',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const session = await resumeSessionById(core.accessor, session_id);
      if (session === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      if (!restoreEnabled(core)) {
        reply.send(errEnvelope(ErrorCode.CAPABILITY_UNSUPPORTED, RESTORE_DISABLED_MESSAGE, req.id));
        return;
      }
      const agent = await ensureMainAgent(session);
      const history = agent.accessor.get(IAgentFileHistoryService);
      reply.send(okEnvelope({ turns: await history.turns() }, req.id));
    },
  );
  app.get(
    turnsRoute.path,
    turnsRoute.options,
    turnsRoute.handler as Parameters<FileHistoryRouteHost['get']>[2],
  );

  const restoreRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/file-history/restore',
      params: sessionIdParamSchema,
      body: fileHistoryRestoreRequestSchema,
      success: { data: fileHistoryRestoreResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.CAPABILITY_UNSUPPORTED]: {},
      },
      description: 'Restore files to their state at the start of a turn',
      operationId: 'restoreFiles',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const session = await resumeSessionById(core.accessor, session_id);
      if (session === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      if (!restoreEnabled(core)) {
        reply.send(errEnvelope(ErrorCode.CAPABILITY_UNSUPPORTED, RESTORE_DISABLED_MESSAGE, req.id));
        return;
      }
      const agent = await ensureMainAgent(session);
      const history = agent.accessor.get(IAgentFileHistoryService);
      const result = await history.restore(req.body.turn_id, req.body.paths, {
        force: req.body.force ?? false,
      });
      reply.send(okEnvelope(result, req.id));
    },
  );
  app.post(
    restoreRoute.path,
    restoreRoute.options,
    restoreRoute.handler as Parameters<FileHistoryRouteHost['post']>[2],
  );
}

function restoreEnabled(core: Scope): boolean {
  return core.accessor.get(IFlagService).enabled(FILE_RESTORE_FLAG_ID);
}
