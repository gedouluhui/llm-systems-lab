import { validateInput, LabError } from '../../../packages/contracts/index.js';
export const LESSON_IDS = ['baseline', 'overwrite', 'recompute'];
const FAULTS = {
    baseline: 'none', overwrite: 'cache-overwrite', recompute: 'no-cache-recompute',
};
export function lessonInput(id) {
    if (!Object.prototype.hasOwnProperty.call(FAULTS, id))
        throw new LabError('INPUT', 'Unknown lesson');
    return validateInput({ schemaVersion: 1, seed: 7, tokens: [1, 4, 2, 8, 3, 9], fault: FAULTS[id] });
}
export function navigatePosition(current, length, action, first) {
    const target = action === 'home' ? 0 : action === 'end' ? length - 1
        : action === 'previous' ? current - 1 : action === 'next' ? current + 1 : first ?? current;
    return Math.max(0, Math.min(Math.max(0, length - 1), target));
}
