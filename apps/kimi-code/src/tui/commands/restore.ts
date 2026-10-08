import type {
  FileHistoryRestoreResult,
  FileHistoryTurnSummary,
  Session,
} from '@moonshot-ai/kimi-code-sdk';

import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

const RESTORE_BUSY_MESSAGE = 'Cannot restore files while streaming — press Esc or Ctrl-C first.';
const RESTORE_EMPTY_MESSAGE =
  'Nothing to restore. File history only covers the five most recent turns that changed files.';
const RESTORE_USAGE_MESSAGE = 'Usage: /restore [turn] [--force].';
const RESTORE_PICKER_NOTICE =
  'Restoring rewinds every file the turn changed. Files changed since then are kept unless forced.';

export async function handleRestoreCommand(
  host: SlashCommandHost,
  args: string = '',
): Promise<void> {
  if (host.state.appState.streamingPhase !== 'idle') {
    host.showError(RESTORE_BUSY_MESSAGE);
    return;
  }
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const parsed = parseRestoreArgs(args);
  if (parsed === undefined) {
    host.showError(RESTORE_USAGE_MESSAGE);
    return;
  }

  const turns = await listTurns(host, session);
  if (turns === undefined) return;
  if (turns.length === 0) {
    host.showStatus(RESTORE_EMPTY_MESSAGE, 'warning');
    return;
  }

  if (parsed.turnId !== undefined) {
    const turn = turns.find((entry) => entry.turnId === parsed.turnId);
    if (turn === undefined) {
      host.showError(formatUnknownTurnMessage(parsed.turnId, turns));
      return;
    }
    await restoreTurn(host, session, turn, parsed.force);
    return;
  }

  showTurnPicker(host, session, turns);
}

async function listTurns(
  host: SlashCommandHost,
  session: Session,
): Promise<readonly FileHistoryTurnSummary[] | undefined> {
  try {
    return await session.listFileChanges();
  } catch (error) {
    host.showError(`Failed to read file history: ${formatErrorMessage(error)}`);
    return undefined;
  }
}

function showTurnPicker(
  host: SlashCommandHost,
  session: Session,
  turns: readonly FileHistoryTurnSummary[],
): void {
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: 'Restore files to the start of…',
      notice: RESTORE_PICKER_NOTICE,
      noticeTone: 'warning',
      options: turns.map((turn) => ({
        value: String(turn.turnId),
        label: `Turn ${String(turn.turnId)}`,
        description: formatTurnDescription(turn),
      })),
      initialValue: String(turns[0]!.turnId),
      onSelect: (value) => {
        host.restoreEditor();
        const turn = turns.find((entry) => entry.turnId === Number(value));
        if (turn === undefined) return;
        void restoreTurn(host, session, turn, false);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function restoreTurn(
  host: SlashCommandHost,
  session: Session,
  turn: FileHistoryTurnSummary,
  force: boolean,
): Promise<void> {
  let result: FileHistoryRestoreResult;
  try {
    result = await session.restoreFiles(turn.turnId, { force });
  } catch (error) {
    host.showError(`Failed to restore files: ${formatErrorMessage(error)}`);
    return;
  }
  host.showStatus(
    renderRestoreResult(turn, result, force),
    result.files.some((file) => file.state === 'conflict') ? 'warning' : 'success',
  );
}

function renderRestoreResult(
  turn: FileHistoryTurnSummary,
  result: FileHistoryRestoreResult,
  force: boolean,
): string {
  if (result.files.length === 0) {
    return `Turn ${String(turn.turnId)} changed no restorable files.`;
  }
  const lines = result.files.map(
    (file) => `${file.state}: ${file.path}${file.detail === undefined ? '' : ` (${file.detail})`}`,
  );
  const count = (state: FileHistoryRestoreResult['files'][number]['state']): number =>
    result.files.filter((file) => file.state === state).length;
  const restored = count('restored');
  const unchanged = count('unchanged');
  const conflicted = count('conflict');
  const skipped = count('oversize') + count('unavailable');
  const summary = [
    `Rewound turn ${String(turn.turnId)}:`,
    `${String(restored)} restored`,
    `${String(unchanged)} unchanged`,
    conflicted > 0 ? `${String(conflicted)} conflict` : undefined,
    skipped > 0 ? `${String(skipped)} oversize or unavailable` : undefined,
  ];
  if (conflicted > 0 && !force) {
    summary.push(`Re-run /restore ${String(turn.turnId)} --force to overwrite the conflicts.`);
  }
  return [...lines, summary.join(', ')].join('\n');
}

interface ParsedRestoreArgs {
  readonly turnId: number | undefined;
  readonly force: boolean;
}

function parseRestoreArgs(args: string): ParsedRestoreArgs | undefined {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  let force = false;
  const positional: string[] = [];
  for (const token of tokens) {
    if (token === '--force' || token === '-f') {
      force = true;
      continue;
    }
    if (token.startsWith('-')) return undefined;
    positional.push(token);
  }
  if (positional.length > 1) return undefined;
  if (positional.length === 0) return { turnId: undefined, force };
  const token = positional[0]!;
  if (!/^\d+$/.test(token)) return undefined;
  return { turnId: Number(token), force };
}

function formatTurnDescription(turn: FileHistoryTurnSummary): string {
  const files = turn.changes.map((change) => `${change.status} ${change.path}`);
  const shown = files.slice(0, 3).join(', ');
  const rest = files.length - 3;
  if (rest > 0) return `${shown}, +${String(rest)} more`;
  return shown.length > 0 ? shown : 'no file changes recorded';
}

function formatUnknownTurnMessage(
  turnId: number,
  turns: readonly FileHistoryTurnSummary[],
): string {
  const restorable = turns.map((turn) => String(turn.turnId)).join(', ');
  return `Turn ${String(turnId)} cannot be restored. Restorable turns: ${restorable}.`;
}