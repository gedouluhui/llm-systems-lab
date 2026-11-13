import { MODEL_SPEC } from '../contracts/index.js';

/**
 * Float64 dot product over a slice of two Float32Arrays.  The product and the
 * running sum never round to float32; the caller materializes the result.
 */
export function dot(
  left: Float32Array,
  leftOffset: number,
  right: Float32Array,
  rightOffset: number,
  count: number,
): number {
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    total += left[leftOffset + index]! * right[rightOffset + index]!;
  }
  return total;
}

/**
 * Layer normalization over ``width`` consecutive values.  Mean and variance
 * are accumulated in float64, the variance is divided by the feature count,
 * epsilon is 1e-5, and every output element is rounded to float32 once.
 */
export function layerNorm(input: Float32Array, offset: number, width: number): Float32Array {
  let sum = 0;
  for (let index = 0; index < width; index += 1) {
    sum += input[offset + index]!;
  }
  const mean = sum / width;

  let squared = 0;
  for (let index = 0; index < width; index += 1) {
    const centered = input[offset + index]! - mean;
    squared += centered * centered;
  }
  const variance = squared / width;
  const denominator = Math.sqrt(variance + MODEL_SPEC.layerNormEpsilon);

  const output = new Float32Array(width);
  for (let index = 0; index < width; index += 1) {
    output[index] = (input[offset + index]! - mean) / denominator;
  }
  return output;
}

/**
 * Numerically stable softmax over ``count`` float64 scores.  The maximum is
 * subtracted in float64, the denominator is a float64 sum, and probabilities
 * are rounded to float32 individually.
 */
export function softmaxRow(scores: Float64Array, count: number): Float32Array {
  let maximum = -Infinity;
  for (let index = 0; index < count; index += 1) {
    const score = scores[index]!;
    if (score > maximum) {
      maximum = score;
    }
  }

  const exponentials = new Float64Array(count);
  let denominator = 0;
  for (let index = 0; index < count; index += 1) {
    const value = Math.exp(scores[index]! - maximum);
    exponentials[index] = value;
    denominator += value;
  }

  const output = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    output[index] = exponentials[index]! / denominator;
  }
  return output;
}

/**
 * Row-major matrix product: ``left`` is rows x columns and ``right`` is
 * columns x rightColumns.  Every element accumulates in float64 and is
 * rounded to float32 once.
 */
export function matmul(
  left: Float32Array,
  rows: number,
  columns: number,
  right: Float32Array,
  rightColumns: number,
): Float32Array {
  const output = new Float32Array(rows * rightColumns);
  for (let row = 0; row < rows; row += 1) {
    const leftRow = row * columns;
    const outputRow = row * rightColumns;
    for (let column = 0; column < rightColumns; column += 1) {
      let total = 0;
      for (let index = 0; index < columns; index += 1) {
        total += left[leftRow + index]! * right[index * rightColumns + column]!;
      }
      output[outputRow + column] = total;
    }
  }
  return output;
}
