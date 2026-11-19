import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(PROJECT_ROOT, 'apps', 'web', 'dist');
const STATIC = path.join(PROJECT_ROOT, 'apps', 'web', 'static');
const ALLOWED_EXTENSIONS = new Set(['.html', '.css', '.js', '.json', '.svg', '.ico', '.map']);

export const WEB_MAX_BYTES = 2 * 1024 * 1024;

function resolveTsc() {
  const candidates = [
    path.join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(PROJECT_ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('TypeScript compiler not found under node_modules; run npm install');
}

function walk(directory, base = directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink()) {
      throw new Error(`web build must not contain symlinks: ${absolute}`);
    }
    if (entry.isDirectory()) {
      walk(absolute, base, files);
    } else if (entry.isFile()) {
      files.push(path.relative(base, absolute).split(path.sep).join('/'));
    }
  }
  return files;
}

function validateDist() {
  if (!existsSync(path.join(DIST, 'index.html'))) {
    throw new Error('web build is missing index.html');
  }
  if (!existsSync(path.join(DIST, 'apps', 'web', 'src', 'main.js'))) {
    throw new Error('web build is missing apps/web/src/main.js');
  }
  if (!existsSync(path.join(DIST, 'apps', 'web', 'src', 'experiment-worker.js'))) {
    throw new Error('web build is missing apps/web/src/experiment-worker.js');
  }
  const files = walk(DIST);
  let totalBytes = 0;
  for (const relative of files) {
    if (relative.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(`invalid web build path: ${relative}`);
    }
    const extension = path.extname(relative);
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new Error(`unexpected web build file type: ${relative}`);
    }
    totalBytes += statSync(path.join(DIST, relative)).size;
  }
  if (totalBytes > WEB_MAX_BYTES) {
    throw new Error(`web build is ${totalBytes} bytes, above the ${WEB_MAX_BYTES} byte budget`);
  }
  return { totalBytes, files };
}

/**
 * Cleans apps/web/dist, compiles the browser TypeScript project, copies the
 * static shell, and fails closed on unexpected files or an oversized bundle.
 */
export function buildWeb() {
  rmSync(DIST, { recursive: true, force: true });
  const tsc = resolveTsc();
  const compiled = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.web.json'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  if (compiled.status !== 0) {
    const detail = [compiled.stdout, compiled.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`web TypeScript build failed (exit ${compiled.status})\n${detail}`);
  }
  mkdirSync(DIST, { recursive: true });
  for (const name of ['index.html', 'styles.css']) {
    copyFileSync(path.join(STATIC, name), path.join(DIST, name));
  }
  return validateDist();
}

if (process.argv[1] !== undefined) {
  const invokedDirectly = import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  if (invokedDirectly) {
    try {
      const result = buildWeb();
      console.log(`web build: ${result.files.length} files, ${result.totalBytes} bytes`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }
}
