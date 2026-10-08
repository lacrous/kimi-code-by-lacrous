import type {
  FileHistoryRestoreResult,
  FileHistoryTurnSummary,
} from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { handleUndoCommand } from '#/tui/commands/undo';
import { handleRestoreCommand } from '#/tui/commands/restore';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import type { TranscriptEntry } from '#/tui/types';

function entry(partial: Partial<TranscriptEntry> & Pick<TranscriptEntry, 'kind' | 'content'>): TranscriptEntry {
  return {
    id: `t-${Math.random().toString(36).slice(2, 10)}`,
    turnId: undefined,
    renderMode: 'plain',
    ...partial,
  };
}

function hostWith(entries: TranscriptEntry[]): SlashCommandHost {
  return {
    session: { undoHistory: vi.fn(async () => {}) },
    state: {
      transcriptEntries: entries,
      transcriptContainer: { children: [], addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
      appState: { streamingPhase: 'idle' },
    },
    showError: vi.fn(),
  } as unknown as SlashCommandHost;
}

describe('/undo with bundled prompts', () => {
  it('removes the bundle cards with their prompt, keeping a standalone skill card before them', async () => {
    const entries: TranscriptEntry[] = [
      entry({ kind: 'user', content: 'earlier question' }),
      entry({
        kind: 'skill_activation',
        content: 'Activated skill: review',
        skillTrigger: 'user-slash',
      }),
      entry({ kind: 'user', content: 'prompt one' }),
      entry({ kind: 'assistant', content: 'answer one' }),
      entry({
        kind: 'skill_activation',
        content: 'Activated skill: security',
        skillTrigger: 'user-slash',
        bundledWithPrompt: true,
      }),
      entry({ kind: 'user', content: 'prompt two' }),
      entry({ kind: 'assistant', content: 'answer two' }),
    ];
    const host = hostWith(entries);

    await handleUndoCommand(host, '1');

    expect(host.session?.undoHistory).toHaveBeenCalledWith(1);
    expect(entries.map((item) => item.content)).toEqual([
      'earlier question',
      'Activated skill: review',
      'prompt one',
      'answer one',
    ]);
  });

  it('removes bundle cards around an interleaved hook result and keeps the hook result', async () => {
    const entries: TranscriptEntry[] = [
      entry({
        kind: 'skill_activation',
        content: 'Activated skill: review',
        skillTrigger: 'user-slash',
        bundledWithPrompt: true,
      }),
      entry({ kind: 'assistant', content: 'hook note', hookResult: true }),
      entry({ kind: 'user', content: 'bundled prompt' }),
      entry({ kind: 'assistant', content: 'bundled answer' }),
    ];
    const host = hostWith(entries);

    await handleUndoCommand(host, '1');

    expect(host.session?.undoHistory).toHaveBeenCalledWith(1);
    expect(entries.map((item) => item.content)).toEqual(['hook note']);
  });

  it('does not count bundle cards as undo anchors of their own', async () => {
    const entries: TranscriptEntry[] = [
      entry({ kind: 'user', content: 'prompt one' }),
      entry({ kind: 'assistant', content: 'answer one' }),
      entry({
        kind: 'skill_activation',
        content: 'Activated skill: review',
        skillTrigger: 'user-slash',
        bundledWithPrompt: true,
      }),
      entry({ kind: 'user', content: 'prompt two' }),
      entry({ kind: 'assistant', content: 'answer two' }),
    ];
    const host = hostWith(entries);

    await handleUndoCommand(host, '2');

    expect(host.session?.undoHistory).toHaveBeenCalledWith(2);
    expect(entries).toHaveLength(0);
  });
});

describe('/undo todo panel refresh', () => {
  function hostWithTodos(
    entries: TranscriptEntry[],
    session: Record<string, unknown>,
  ): { host: SlashCommandHost; setTodoList: ReturnType<typeof vi.fn> } {
    const host = hostWith(entries);
    const setTodoList = vi.fn();
    (host as { streamingUI?: unknown }).streamingUI = { setTodoList };
    (host as { session?: unknown }).session = session;
    return { host, setTodoList };
  }

  it('re-pulls the engine todo state after a successful undo', async () => {
    const entries: TranscriptEntry[] = [
      entry({ kind: 'user', content: 'question' }),
      entry({ kind: 'assistant', content: 'answer' }),
    ];
    const { host, setTodoList } = hostWithTodos(entries, {
      undoHistory: vi.fn(async () => {}),
      getTodos: vi.fn(async () => [{ title: 'kept', status: 'pending' }]),
    });

    await handleUndoCommand(host, '1');

    expect(setTodoList).toHaveBeenCalledWith([{ title: 'kept', status: 'pending' }]);
  });

  it('keeps the panel as-is when the engine has no todo read surface', async () => {
    const entries: TranscriptEntry[] = [
      entry({ kind: 'user', content: 'question' }),
      entry({ kind: 'assistant', content: 'answer' }),
    ];
    const { host, setTodoList } = hostWithTodos(entries, {
      undoHistory: vi.fn(async () => {}),
      getTodos: vi.fn(async () => {
        throw new Error('getTodos is only available on the agent-core-v2 engine.');
      }),
    });

    await handleUndoCommand(host, '1');

    expect(setTodoList).not.toHaveBeenCalled();
  });

  it('hides the panel when the restored todos are all done', async () => {
    const entries: TranscriptEntry[] = [
      entry({ kind: 'user', content: 'question' }),
      entry({ kind: 'assistant', content: 'answer' }),
    ];
    const { host, setTodoList } = hostWithTodos(entries, {
      undoHistory: vi.fn(async () => {}),
      getTodos: vi.fn(async () => [{ title: 'finished', status: 'done' }]),
    });

    await handleUndoCommand(host, '1');

    expect(setTodoList).toHaveBeenCalledWith([]);
  });
});

const ENTER = '\r';
const ESCAPE = '\u001B';
const DOWN = '\u001B[B';

const RESTORABLE_TURNS: readonly FileHistoryTurnSummary[] = [
  {
    turnId: 7,
    changes: [{ path: 'src/app.ts', status: 'modified', additions: 12, deletions: 3 }],
  },
  {
    turnId: 6,
    changes: [
      { path: 'src/app.ts', status: 'modified', additions: 4, deletions: 1 },
      { path: 'src/legacy.ts', status: 'deleted', additions: 0, deletions: 90 },
    ],
  },
];

interface RestoreFixture {
  readonly host: SlashCommandHost;
  readonly restoreFiles: ReturnType<typeof vi.fn>;
  readonly showStatus: ReturnType<typeof vi.fn>;
  readonly showError: ReturnType<typeof vi.fn>;
}

function restoreHost(
  overrides: {
    turns?: readonly FileHistoryTurnSummary[];
    result?: FileHistoryRestoreResult;
    listFileChanges?: () => Promise<readonly FileHistoryTurnSummary[]>;
    restoreFiles?: (
      turnId: number,
      options?: { readonly force: boolean },
    ) => Promise<FileHistoryRestoreResult>;
  } = {},
): RestoreFixture {
  const restoreFiles = vi.fn(
    overrides.restoreFiles ??
      (async (turnId: number): Promise<FileHistoryRestoreResult> =>
        overrides.result ?? { turnId, files: [{ path: 'src/app.ts', state: 'restored' }] }),
  );
  const showStatus = vi.fn();
  const showError = vi.fn();
  const host = {
    session: {
      listFileChanges:
        overrides.listFileChanges ?? (async () => overrides.turns ?? RESTORABLE_TURNS),
      restoreFiles,
    },
    state: {
      transcriptEntries: [],
      transcriptContainer: { children: [], addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
      appState: { streamingPhase: 'idle' },
    },
    showError,
    showStatus,
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, restoreFiles, showStatus, showError };
}

function mountedPicker(host: SlashCommandHost): { handleInput(data: string): void } {
  const mount = host.mountEditorReplacement as ReturnType<typeof vi.fn>;
  return mount.mock.calls.at(-1)?.[0] as { handleInput(data: string): void };
}

describe('/restore', () => {
  it('restores the turn picked in the picker', async () => {
    const { host, restoreFiles, showStatus } = restoreHost();

    await handleRestoreCommand(host, '');
    mountedPicker(host).handleInput(DOWN);
    mountedPicker(host).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(restoreFiles).toHaveBeenCalledWith(6, { force: false });
    });
    await vi.waitFor(() => {
      expect(showStatus).toHaveBeenCalledWith(
        expect.stringContaining('restored: src/app.ts'),
        'success',
      );
    });
  });

  it('restores the cursor turn when the picker is confirmed as-is', async () => {
    const { host, restoreFiles } = restoreHost();

    await handleRestoreCommand(host, '');
    mountedPicker(host).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(restoreFiles).toHaveBeenCalledWith(7, { force: false });
    });
  });

  it('restores nothing when the picker is cancelled', async () => {
    const { host, restoreFiles, showStatus } = restoreHost();

    await handleRestoreCommand(host, '');
    mountedPicker(host).handleInput(ESCAPE);

    expect(restoreFiles).not.toHaveBeenCalled();
    expect(showStatus).not.toHaveBeenCalled();
  });

  it('reports every restore state, including conflicts, and how to force them', async () => {
    const { host, showStatus } = restoreHost({
      result: {
        turnId: 7,
        files: [
          { path: 'src/app.ts', state: 'restored' },
          { path: 'src/untouched.ts', state: 'unchanged' },
          { path: 'src/drifted.ts', state: 'conflict', detail: 'changed since turn 7' },
          { path: 'assets/logo.png', state: 'oversize' },
          { path: 'src/gone.ts', state: 'unavailable', detail: 'no backup kept' },
        ],
      },
    });

    await handleRestoreCommand(host, '7');

    const [message, tone] = showStatus.mock.calls[0] as [string, string];
    expect(tone).toBe('warning');
    expect(message).toContain('restored: src/app.ts');
    expect(message).toContain('unchanged: src/untouched.ts');
    expect(message).toContain('conflict: src/drifted.ts (changed since turn 7)');
    expect(message).toContain('oversize: assets/logo.png');
    expect(message).toContain('unavailable: src/gone.ts (no backup kept)');
    expect(message).toContain('Re-run /restore 7 --force to overwrite the conflicts.');
  });

  it('drops the force hint once conflicts were forced through', async () => {
    const { host, restoreFiles, showStatus } = restoreHost({
      result: {
        turnId: 7,
        files: [{ path: 'src/drifted.ts', state: 'restored' }],
      },
    });

    await handleRestoreCommand(host, '7 --force');

    expect(restoreFiles).toHaveBeenCalledWith(7, { force: true });
    expect(showStatus.mock.calls[0]?.[0]).not.toContain('--force');
  });

  it('says there is nothing to restore when no turn has recorded file history', async () => {
    const { host, restoreFiles, showStatus, showError } = restoreHost({ turns: [] });

    await handleRestoreCommand(host, '');

    expect(showStatus).toHaveBeenCalledWith(expect.stringContaining('Nothing to restore'), 'warning');
    expect(restoreFiles).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('refuses to restore while the agent is still streaming', async () => {
    const { host, restoreFiles, showError } = restoreHost();
    (host.state.appState as { streamingPhase: string }).streamingPhase = 'streaming';

    await handleRestoreCommand(host, '7');

    expect(restoreFiles).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith(expect.stringContaining('Cannot restore files'));
  });

  it('refuses an unknown turn and names the restorable ones', async () => {
    const { host, restoreFiles, showError } = restoreHost();

    await handleRestoreCommand(host, '3');

    expect(restoreFiles).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith(
      'Turn 3 cannot be restored. Restorable turns: 7, 6.',
    );
  });

  it('surfaces a failed history read instead of reporting a success', async () => {
    const { host, restoreFiles, showError, showStatus } = restoreHost({
      listFileChanges: async () => {
        throw new Error('file_restore is disabled');
      },
    });

    await handleRestoreCommand(host, '');

    expect(restoreFiles).not.toHaveBeenCalled();
    expect(showStatus).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith(
      'Failed to read file history: file_restore is disabled',
    );
  });

  it('surfaces a failed restore instead of reporting a success', async () => {
    const { host, showError, showStatus } = restoreHost({
      restoreFiles: async () => {
        throw new Error('disk is full');
      },
    });

    await handleRestoreCommand(host, '7');

    expect(showStatus).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith('Failed to restore files: disk is full');
  });

  it('rejects unrecognized arguments with the usage line', async () => {
    const { host, restoreFiles, showError } = restoreHost();

    await handleRestoreCommand(host, '--dry-run 7');

    expect(restoreFiles).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith('Usage: /restore [turn] [--force].');
  });
});
