import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { GOAL_MAIN_AGENT_ONLY, mainAgentOnlyExecution } from '#/agent/tools/mainAgentOnly';
import { type ToolExecution } from '#/tool/toolContract';

import { IAgentGoalService } from '#/features/goal/goalService';
import {
  buildGoalBlockedReasonPrompt,
  buildGoalCompletionSummaryPrompt,
} from '#/features/goal/tools/outcome-prompts';
import { ICompletionCriteriaService } from '#/features/computerUse/completionCriteriaService';
import { gateCompletion } from '#/features/computerUse/completionGate';
import { createNodeCheckContext } from '#/features/computerUse/nodeCheckContext';
import { isVerificationEnabled } from '#/features/computerUse/verificationFlag';

import DESCRIPTION from './update-goal.md?raw';
import {
  UpdateGoalToolInputSchema,
  IUpdateGoalTool,
  type UpdateGoalToolInput,
} from './update-goal';

export class UpdateGoalTool implements IUpdateGoalTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'UpdateGoal' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(UpdateGoalToolInputSchema);

  constructor(
    @IAgentGoalService private readonly goal: IAgentGoalService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ICompletionCriteriaService private readonly criteria?: ICompletionCriteriaService,
  ) {}

  resolveExecution(args: UpdateGoalToolInput): ToolExecution {
    const denied = mainAgentOnlyExecution(this.scopeContext, GOAL_MAIN_AGENT_ONLY);
    if (denied !== undefined) return denied;
    if (!isUpdateGoalStatus(args.status)) {
      return {
        isError: true,
        output: 'Invalid goal status. Use `active`, `complete`, or `blocked`.',
      };
    }

    const status = args.status;
    const currentGoal = this.goal.getGoal().goal;
    const goalIsActive = currentGoal?.status === 'active';

    return {
      description: `Setting goal status: ${status}`,
      stopBatchAfterThis: status !== 'active' && goalIsActive,
      approvalRule: this.name,
      execute: async ({ turnId }) => {
        const goalAtExecution = this.goal.getGoal().goal;
        if (goalAtExecution === null || (currentGoal === null && status === 'active')) {
          return { output: missingGoalOutput(status) };
        }
        if (
          goalAtExecution.goalId !== currentGoal?.goalId &&
          !this.goal.isGoalToolTarget(turnId, goalAtExecution.goalId)
        ) {
          return { output: changedGoalOutput(status) };
        }
        if (status === 'active') {
          await this.goal.resumeGoal({}, 'model');
          return { output: 'Goal resumed.' };
        }
        if (status === 'complete') {
          const refusal = await this._verifyCompletion(goalAtExecution.goalId);
          if (refusal !== undefined) {
            return { isError: true, output: refusal };
          }
          const completed = await this.goal.markComplete({}, 'model');
          if (completed === null) {
            return { output: 'Goal not completed: no active goal.' };
          }
          return { output: buildGoalCompletionSummaryPrompt(completed), stopTurn: true };
        }
        if (status === 'blocked') {
          const blocked = await this.goal.markBlocked({}, 'model');
          if (blocked === null) {
            return { output: 'Goal not blocked: no active goal.' };
          }
          return { output: buildGoalBlockedReasonPrompt(blocked), stopTurn: true };
        }
        return {
          isError: true,
          output: 'Invalid goal status. Use `active`, `complete`, or `blocked`.',
        };
      },
    };
  }

  private async _verifyCompletion(goalId: string): Promise<string | undefined> {
    if (!isVerificationEnabled() || this.criteria === undefined) return undefined;
    const criteria = await this.criteria.criteriaFor(goalId);
    const evidence = await this.criteria.evidenceFor(goalId);
    const result = await gateCompletion({
      criteria,
      evidence,
      facts: this.criteria.factsFor(goalId),
      context: createNodeCheckContext(evidence, { timeoutMs: 30_000 }),
      enforce: true,
    });
    return result.allowed ? undefined : result.feedback;
  }
}

function isUpdateGoalStatus(status: unknown): status is UpdateGoalToolInput['status'] {
  return status === 'active' || status === 'complete' || status === 'blocked';
}

function missingGoalOutput(status: UpdateGoalToolInput['status']): string {
  if (status === 'active') return 'Goal not resumed: no current goal.';
  if (status === 'complete') return 'Goal not completed: no active goal.';
  return 'Goal not blocked: no active goal.';
}

function changedGoalOutput(status: UpdateGoalToolInput['status']): string {
  if (status === 'active') return 'Goal not resumed: the current goal changed.';
  if (status === 'complete') return 'Goal not completed: the current goal changed.';
  return 'Goal not blocked: the current goal changed.';
}
