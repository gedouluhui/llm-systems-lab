#!/usr/bin/env node
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import {
  FAULTS,
  LabError,
  MODEL_SPEC,
  validateSeed,
  type FaultMode,
} from '../packages/contracts/index.js';
import {
  ENGINE_VERSION,
  replayExperiment,
  runExperiment,
  type ExperimentResult,
} from '../packages/core/index.js';

const DEMO_SEED = 7;
const DEMO_TOKENS = [1, 4, 2, 8, 3, 9] as const;
const MAX_REPLAY_BYTES = 1024 * 1024;
const USAGE = [
  'usage: llm-systems-lab run --seed N --tokens 1,2,3 [--fault MODE]',
  '       llm-systems-lab replay FILE',
  '       llm-systems-lab demo',
  '       llm-systems-lab --version',
  `faults: ${FAULTS.join(', ')}`,
].join('\n');

interface RunOptions {
  seed: number;
  tokens: number[];
  fault: FaultMode;
}

function parseDecimal(flag: string, value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new LabError('INPUT', `${flag} must be a non-negative decimal integer`);
  }
  return Number(value);
}

function parseTokens(value: string): number[] {
  const parts = value.split(',');
  return parts.map((part, index) => {
    if (!/^(0|[1-9][0-9]*)$/.test(part)) {
      throw new LabError('INPUT', `token ${index} must be a non-negative decimal integer`);
    }
    return Number(part);
  });
}

function parseRunOptions(args: readonly string[]): RunOptions {
  let seed: number | undefined;
  let tokens: number[] | undefined;
  let fault: FaultMode = 'none';
  let faultSet = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag !== '--seed' && flag !== '--tokens' && flag !== '--fault') {
      throw new LabError('INPUT', `unknown option "${flag}"\n${USAGE}`);
    }
    if (index + 1 >= args.length) {
      throw new LabError('INPUT', `option ${flag} requires a value\n${USAGE}`);
    }
    const value = args[index + 1]!;
    index += 1;
    if (flag === '--seed') {
      if (seed !== undefined) {
        throw new LabError('INPUT', '--seed was provided more than once');
      }
      seed = validateSeed(parseDecimal(flag, value));
    } else if (flag === '--tokens') {
      if (tokens !== undefined) {
        throw new LabError('INPUT', '--tokens was provided more than once');
      }
      tokens = parseTokens(value);
    } else {
      if (faultSet) {
        throw new LabError('INPUT', '--fault was provided more than once');
      }
      faultSet = true;
      if (!(FAULTS as readonly string[]).includes(value)) {
        throw new LabError('INPUT', `unknown fault "${value}"; expected one of ${FAULTS.join(', ')}`);
      }
      fault = value as FaultMode;
    }
  }
  if (seed === undefined) {
    throw new LabError('INPUT', `--seed is required\n${USAGE}`);
  }
  if (tokens === undefined) {
    throw new LabError('INPUT', `--tokens is required\n${USAGE}`);
  }
  return { seed, tokens, fault };
}

function printReport(report: ExperimentResult): void {
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

async function commandRun(args: readonly string[]): Promise<number> {
  const options = parseRunOptions(args);
  const report = await runExperiment({
    schemaVersion: 1,
    seed: options.seed,
    tokens: options.tokens,
    fault: options.fault,
  });
  printReport(report);
  return report.comparison.passes ? 0 : 1;
}

function readReplayText(file: unknown): string {
  if (typeof file !== 'string' || file.length === 0) {
    throw new LabError('INPUT', `replay requires a file path\n${USAGE}`);
  }
  let descriptor: number;
  try {
    descriptor = openSync(file, 'r');
  } catch {
    throw new LabError('INPUT', `cannot open replay file "${file}"`);
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new LabError('INPUT', 'replay path must be a regular file');
    }
    const buffer = Buffer.alloc(MAX_REPLAY_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk === 0) {
        break;
      }
      bytesRead += chunk;
    }
    if (bytesRead > MAX_REPLAY_BYTES) {
      throw new LabError('INPUT', 'replay file exceeds 1 MiB');
    }
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}

async function commandReplay(args: readonly string[]): Promise<number> {
  if (args.length !== 1) {
    throw new LabError('INPUT', `replay requires exactly one file path\n${USAGE}`);
  }
  const text = readReplayText(args[0]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LabError('INPUT', 'replay file is not valid JSON');
  }
  const report = await replayExperiment(parsed);
  printReport(report);
  return report.comparison.passes ? 0 : 1;
}

async function commandDemo(args: readonly string[]): Promise<number> {
  if (args.length !== 0) {
    throw new LabError('INPUT', `demo takes no arguments\n${USAGE}`);
  }
  const lines: string[] = [];
  lines.push(`llm-systems-lab ${ENGINE_VERSION} numerical demo`);
  lines.push(`model: ${MODEL_SPEC.id} (untrained, deterministic weights)`);
  lines.push(`case: seed=${DEMO_SEED} tokens=${DEMO_TOKENS.join(',')}`);
  lines.push('method: compare the full-prefix path against the cached path at every position');

  const normal = await runExperiment({
    schemaVersion: 1,
    seed: DEMO_SEED,
    tokens: [...DEMO_TOKENS],
    fault: 'none',
  });
  let ok = normal.comparison.passes;
  lines.push(
    `normal: ${ok ? 'PASS' : 'FAIL'} (firstDivergence=${String(normal.comparison.firstDivergence)})`,
  );

  for (const fault of FAULTS) {
    if (fault === 'none') {
      continue;
    }
    const result = await runExperiment({
      schemaVersion: 1,
      seed: DEMO_SEED,
      tokens: [...DEMO_TOKENS],
      fault,
    });
    if (fault === 'no-cache-recompute') {
      const degraded = result.comparison.passes
        && result.workSummary.totalRecomputeTokens > result.workSummary.expectedCachedTokens;
      ok = ok && degraded;
      lines.push(
        `no-cache-recompute: PASS numerically, work ${result.workSummary.complexityClass} `
        + `(${result.workSummary.totalRecomputeTokens} recomputed tokens vs `
        + `${result.workSummary.expectedCachedTokens} cached steps)`,
      );
      continue;
    }
    const diverged = !result.comparison.passes && result.comparison.firstDivergence !== null;
    ok = ok && diverged;
    lines.push(
      diverged
        ? `${fault}: DIVERGED at position ${String(result.comparison.firstDivergence)}`
        : `${fault}: NOT DETECTED`,
    );
  }

  lines.push(
    `result: ${ok ? 'PASS' : 'FAIL'} (numerical path only; not model quality, speed, or GPU memory)`,
  );
  process.stdout.write(`${lines.join('\n')}\n`);
  return ok ? 0 : 1;
}

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  const rest = argv.slice(1);
  if (command === 'run') {
    return commandRun(rest);
  }
  if (command === 'replay') {
    return commandReplay(rest);
  }
  if (command === 'demo') {
    return commandDemo(rest);
  }
  if (command === '--version' && rest.length === 0) {
    process.stdout.write(`${ENGINE_VERSION}\n`);
    return 0;
  }
  throw new LabError('INPUT', `unknown command; expected run, replay, demo, or --version\n${USAGE}`);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 2;
}
