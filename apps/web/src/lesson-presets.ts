import { validateInput, LabError } from '../../../packages/contracts/index.js';
import type { ExperimentInput, FaultMode } from '../../../packages/contracts/index.js';

export const LESSON_IDS = ['baseline', 'overwrite', 'recompute'] as const;
export type LessonId = typeof LESSON_IDS[number];
const FAULTS: Record<LessonId, FaultMode> = {
  baseline: 'none', overwrite: 'cache-overwrite', recompute: 'no-cache-recompute',
};

export function lessonInput(id: LessonId): ExperimentInput {
  if (!Object.prototype.hasOwnProperty.call(FAULTS, id)) throw new LabError('INPUT', 'Unknown lesson');
  return validateInput({ schemaVersion: 1, seed: 7, tokens: [1, 4, 2, 8, 3, 9], fault: FAULTS[id] });
}

export type PositionAction = 'previous' | 'next' | 'home' | 'end' | 'divergence';
export function navigatePosition(current: number, length: number, action: PositionAction, first: number | null): number {
  const target = action === 'home' ? 0 : action === 'end' ? length - 1
    : action === 'previous' ? current - 1 : action === 'next' ? current + 1 : first ?? current;
  return Math.max(0, Math.min(Math.max(0, length - 1), target));
}
