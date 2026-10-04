import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';
import { ComputerControlError, type Screenshot } from '#/features/computerUse/types';

const PointSchema = z.object({
  x: z.number().int().describe('Horizontal pixel coordinate, origin at the top-left.'),
  y: z.number().int().describe('Vertical pixel coordinate, origin at the top-left.'),
});

export interface ComputerScreenshotInput {
  readonly target?: 'screen' | 'active_window';
}

export const ComputerScreenshotInputSchema: z.ZodType<ComputerScreenshotInput> = z.object({
  target: z
    .enum(['screen', 'active_window'])
    .optional()
    .describe('Capture the whole screen (default) or only the focused window.'),
});

export interface ComputerClickInput {
  readonly x: number;
  readonly y: number;
  readonly button: 'left' | 'right' | 'middle';
  readonly double?: boolean;
}

export const ComputerClickInputSchema: z.ZodType<Omit<ComputerClickInput, 'button' | 'double'> & {
  button?: 'left' | 'right' | 'middle';
  double?: boolean;
}> = z.object({
  x: PointSchema.shape.x,
  y: PointSchema.shape.y,
  button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button. Defaults to left.'),
  double: z.boolean().optional().describe('Send a double-click instead of a single click.'),
});

export interface ComputerTypeInput {
  readonly text: string;
}

export const ComputerTypeInputSchema: z.ZodType<ComputerTypeInput> = z.object({
  text: z.string().describe('Text to type into the focused element.'),
});

export interface ComputerKeyInput {
  readonly keys: string[];
}

export const ComputerKeyInputSchema: z.ZodType<ComputerKeyInput> = z.object({
  keys: z
    .array(z.string())
    .min(1)
    .describe(
      'Key combination in order, e.g. ["ctrl","c"], or a single key like ["Return"]. Aliases: enter, esc, tab, backspace, ctrl, alt, shift, super.',
    ),
});

export interface ComputerApplicationInput {
  readonly name: string;
}

export const ComputerApplicationInputSchema: z.ZodType<ComputerApplicationInput> = z.object({
  name: z.string().min(1).describe('Application to open, e.g. "chromium" or a .desktop entry.'),
});

export interface IComputerScreenshotTool extends AgentTool<ComputerScreenshotInput> {
  readonly _serviceBrand: undefined;
}
export const IComputerScreenshotTool = createDecorator<IComputerScreenshotTool>('computerScreenshotTool');

export interface IComputerClickTool extends AgentTool<ComputerClickInput> {
  readonly _serviceBrand: undefined;
}
export const IComputerClickTool = createDecorator<IComputerClickTool>('computerClickTool');

export interface IComputerTypeTool extends AgentTool<ComputerTypeInput> {
  readonly _serviceBrand: undefined;
}
export const IComputerTypeTool = createDecorator<IComputerTypeTool>('computerTypeTool');

export interface IComputerKeyTool extends AgentTool<ComputerKeyInput> {
  readonly _serviceBrand: undefined;
}
export const IComputerKeyTool = createDecorator<IComputerKeyTool>('computerKeyTool');

export interface IComputerApplicationTool extends AgentTool<ComputerApplicationInput> {
  readonly _serviceBrand: undefined;
}
export const IComputerApplicationTool = createDecorator<IComputerApplicationTool>('computerApplicationTool');

export function describeFailure(error: unknown): string {
  if (error instanceof ComputerControlError) {
    return `${error.message} (${error.failureClass})`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function formatScreenshot(shot: Screenshot): string {
  const window = shot.activeWindow?.title;
  return [
    `Captured ${String(shot.width)}x${String(shot.height)} at ${new Date(shot.capturedAt).toISOString()}.`,
    window === undefined ? undefined : `Active window: ${window}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}