import { IFlagService } from '#/app/flag/flag';
import { IAgentRuntimeService, inspectAgentRuntime } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { mainAgentOnlyExecution } from '#/agent/tools/mainAgentOnly';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import {
  IAgentFileHistoryService,
  type FileHistoryRestoreOutcome,
  type FileHistoryTurnSummary,
} from '#/features/fileHistory/fileHistory';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { toInputJsonSchema } from '#/tool/input-schema';
import { resolvePathAccessPath, type WorkspaceConfig } from '#/tool/path-access';
import { literalRulePattern, matchesPathRuleSubject } from '#/tool/rule-match';
import {
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { FILE_RESTORE_FLAG_ID } from './flag';
import { IRestoreFileTool, RestoreFileInputSchema, type RestoreFileInput } from './restore-file';
import RESTORE_DESCRIPTION from './restore-file.md?raw';

const RESTORE_MAIN_AGENT_ONLY = 'RestoreFile is only supported by the main agent.';
const RESTORE_DISABLED = 'RestoreFile is disabled. Enable the file_restore experimental flag to use it.';

export class RestoreFileTool implements IRestoreFileTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'RestoreFile' as const;
  readonly description = RESTORE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(RestoreFileInputSchema);

  constructor(
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @IAgentFileHistoryService private readonly fileHistory: IAgentFileHistoryService,
    @IFlagService private readonly flags: IFlagService,
    @ISessionSkillCatalog private readonly skillCatalog?: ISessionSkillCatalog,
  ) {}

  private workspaceConfig(view: RuntimeWorkspaceView): WorkspaceConfig {
    return { workspaceDir: view.workDir, additionalDirs: view.additionalDirs };
  }

  resolveExecution(args: RestoreFileInput): ToolExecution {
    const blocked = mainAgentOnlyExecution(this.agentCtx, RESTORE_MAIN_AGENT_ONLY);
    if (blocked !== undefined) return blocked;

    const inspected = inspectAgentRuntime(this.runtime);
    const view = new RuntimeWorkspaceView(inspected, {
      workDir: this.workspaceCtx.workDir,
      additionalDirs: [
        ...this.workspaceCtx.additionalDirs,
        ...(this.skillCatalog?.catalog.getSkillRoots() ?? []),
      ],
    });
    const env = { _serviceBrand: undefined, ...inspected.environment, ready: Promise.resolve() };
    const workspace = this.workspaceConfig(view);
    const targets = (args.paths ?? []).map((path) =>
      resolvePathAccessPath(path, { env, workspace, operation: 'write' }),
    );
    const subject = args.paths?.join(', ') ?? 'the last turn with file changes';

    return {
      accesses:
        targets.length > 0 ? targets.flatMap((path) => ToolAccesses.writeFile(path)) : undefined,
      description: `Restoring files from ${subject}`,
      display: {
        kind: 'generic',
        summary: `Restore files to their state at the start of ${subject}`,
        detail: targetDetail(args),
      },
      approvalRule: literalRulePattern(this.name, args.paths?.[0] ?? 'turn'),
      matchesRule: (ruleArgs) =>
        targets.length === 0 ||
        targets.some((path) =>
          matchesPathRuleSubject(ruleArgs, path, {
            cwd: workspace.workspaceDir,
            pathClass: env.pathClass,
            homeDir: env.homeDir,
          }),
        ),
      execute: async () => {
        if (!this.flags.enabled(FILE_RESTORE_FLAG_ID)) {
          return { isError: true, output: RESTORE_DISABLED };
        }
        const lease = this.runtime.acquire(['fs']);
        try {
          if (lease.runtime.identity.generation !== inspected.identity.generation) {
            return { isError: true, output: 'Runtime changed before execution. Retry the tool call.' };
          }
          if (lease.runtime.fs === undefined) {
            return { isError: true, output: 'This runtime has no filesystem available.' };
          }
          return await this.restore(args);
        } finally {
          lease.dispose();
        }
      },
    };
  }

  private async restore(args: RestoreFileInput): Promise<ExecutableToolResult> {
    const turns = await this.fileHistory.turns();
    if (turns.length === 0) {
      return {
        isError: true,
        output: 'No restorable turns. File history is kept for the five most recent turns that changed files.',
      };
    }
    const turn = args.turn_id === undefined ? turns[0]! : turns.find((t) => t.turnId === args.turn_id);
    if (turn === undefined) {
      return {
        isError: true,
        output: `Turn ${String(args.turn_id)} is not restorable. Restorable turns: ${describeTurnIds(turns)}.`,
      };
    }

    const result = await this.fileHistory.restore(turn.turnId, args.paths, {
      force: args.force ?? false,
    });
    return { output: renderResult(turn, result.files, turns, args.force ?? false) };
  }
}

registerAgentToolService(IRestoreFileTool, RestoreFileTool, {
  name: 'RestoreFile',
  domain: 'os/backends',
  requiredRuntimeCapabilities: ['fs'],
  when: (accessor) => accessor.get(IFlagService).enabled(FILE_RESTORE_FLAG_ID),
});

function targetDetail(args: RestoreFileInput): string {
  if (args.turn_id !== undefined && args.paths !== undefined) {
    return `turn ${String(args.turn_id)}: ${args.paths.join(', ')}`;
  }
  if (args.turn_id !== undefined) return `turn ${String(args.turn_id)}`;
  if (args.paths !== undefined) return args.paths.join(', ');
  return 'the last turn with file changes';
}

function describeTurnIds(turns: readonly FileHistoryTurnSummary[]): string {
  return turns.map((t) => String(t.turnId)).join(', ');
}

function renderResult(
  turn: FileHistoryTurnSummary,
  files: readonly FileHistoryRestoreOutcome[],
  turns: readonly FileHistoryTurnSummary[],
  force: boolean,
): string {
  if (files.length === 0) {
    return `Turn ${String(turn.turnId)} changed no restorable files. Restorable turns: ${describeTurnIds(turns)}.`;
  }
  const lines = [`Rewound turn ${String(turn.turnId)} (${turn.changes.length} file(s) changed in it).`];
  for (const file of files) {
    lines.push(`  ${file.state.padEnd(11)} ${file.path}${detailSuffix(file)}`);
  }

  const restored = files.filter((f) => f.state === 'restored').length;
  const conflicted = files.filter((f) => f.state === 'conflict').length;
  const skipped = files.filter((f) => f.state === 'oversize' || f.state === 'unavailable').length;
  lines.push(
    `Restored ${String(restored)} of ${String(files.length)} file(s)` +
      `${conflicted > 0 ? `; ${String(conflicted)} conflicted` : ''}` +
      `${skipped > 0 ? `; ${String(skipped)} without a stored copy` : ''}.`,
  );
  if (conflicted > 0 && !force) {
    lines.push('Pass force: true to overwrite the conflicting files.');
  }
  const others = turns.filter((t) => t.turnId !== turn.turnId).map((t) => String(t.turnId));
  if (others.length > 0) {
    lines.push(`Other restorable turns: ${others.join(', ')} — pass turn_id to restore one.`);
  }
  return lines.join('\n');
}

function detailSuffix(file: FileHistoryRestoreOutcome): string {
  return file.detail === undefined ? '' : ` — ${file.detail}`;
}