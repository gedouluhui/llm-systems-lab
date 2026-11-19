import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as harness from '../scripts/e2e-web.mjs';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function isolatedProject(directory) {
  // Build and report writes belong to this disposable copy, never the repo.
  for (const entry of [
    'scripts/e2e-web.mjs', 'scripts/e2e-product.mjs', 'scripts/browser-discovery.mjs',
    'scripts/build-web.mjs', 'scripts/serve-web.mjs',
    'tsconfig.web.json', 'package.json', 'packages',
    'apps/web/src', 'apps/web/static', 'node_modules/typescript',
  ]) {
    cpSync(path.join(ROOT, entry), path.join(directory, entry), { recursive: true });
  }
}

test('successful startup keeps an error guard until disposal and releases it on cleanup', async () => {
  assert.equal(typeof harness.watchBrowserStartup, 'function');
  const profile = mkdtempSync(path.join(tmpdir(), 'lab startup success '));
  let child;
  let startup;
  let closed;
  try {
    // Only our own Node script runs; no installed browser is involved.
    child = spawn(process.execPath, ['-e', `
      require('node:fs').writeFileSync(${JSON.stringify(path.join(profile, 'DevToolsActivePort'))},
        '9222\\n/devtools/browser/test-id\\n');
      setInterval(() => {}, 1000);
    `], { stdio: 'ignore', windowsHide: true });
    startup = harness.watchBrowserStartup(profile, child);
    closed = once(child, 'close');
    assert.equal(child.listenerCount('error'), 2, 'startup and close guards attach synchronously');
    assert.deepEqual(await startup.ready, { port: 9222, wsPath: '/devtools/browser/test-id' });
    assert.equal(child.listenerCount('error'), 2, 'startup guard remains during child shutdown');
    child.kill();
    await closed;
    startup.dispose();
    assert.equal(child.listenerCount('error'), 0);
    startup.dispose();
    assert.equal(child.listenerCount('error'), 0, 'disposal is idempotent');
  } finally {
    if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill();
    if (closed !== undefined) await closed;
    startup?.dispose();
    rmSync(profile, { recursive: true, force: true });
  }
});

function nativeSpawnFailure(t, failure) {
  const directory = mkdtempSync(path.join(tmpdir(), 'lab browser launch '));
  try {
    isolatedProject(directory);
    const executable = path.join(directory, process.platform === 'win32' ? 'browser copy.exe' : 'browser copy');
    copyFileSync(process.execPath, executable);
    chmodSync(executable, 0o755);
    const profiles = path.join(directory, 'profiles');
    mkdirSync(profiles);
    const evidenceFile = path.join(directory, 'launch-evidence.json');
    const reportFile = path.join(directory, 'artifacts', 'a2', 'e2e.json');
    const hook = `
      import assert from 'node:assert/strict';
      import childProcess from 'node:child_process';
      import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const executable = ${JSON.stringify(executable)};
      const evidence = { spawnCalls: 0, killCalls: 0 };
      let child;
      let started;
      process.once('exit', () => {
        evidence.elapsedMs = Date.now() - started;
        evidence.profileExists = existsSync(evidence.profile);
        evidence.reportExists = existsSync(${JSON.stringify(reportFile)});
        evidence.listeners = child === undefined ? {} : Object.fromEntries(
          ['error', 'exit', 'close'].map(name => [name, child.listenerCount(name)]));
        writeFileSync(${JSON.stringify(evidenceFile)}, JSON.stringify(evidence));
      });
      const realSpawn = childProcess.spawn;
      childProcess.spawn = (file, args, options) => {
        assert.equal(file, executable, 'must not launch any installed browser');
        evidence.spawnCalls += 1;
        evidence.existedAtSpawn = existsSync(file);
        evidence.profile = args.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
        assert.ok(evidence.existedAtSpawn, 'candidate must exist through discovery');
        if (${JSON.stringify(failure)} === 'removed executable') unlinkSync(file);
        evidence.removedBeforeSpawn = !existsSync(file);
        started = Date.now();
        try {
          // Invalid arguments exercise native synchronous validation, not a mock throw.
          const spawnArgs = ${JSON.stringify(failure)} === 'invalid spawn argument' ? [...args, '\\0'] : args;
          child = realSpawn(file, spawnArgs, options);
        } catch (error) {
          evidence.errorCode = error.code;
          evidence.synchronous = true;
          throw error;
        }
        evidence.pid = child.pid ?? null;
        // Observe without installing an error listener or swallowing the event:
        // the original emit must still crash if production leaves it unhandled.
        const realEmit = child.emit;
        child.emit = function (name, ...values) {
          if (name === 'error') {
            evidence.errorCode = values[0].code;
            evidence.errorListenersAtEmit = this.listenerCount('error');
          }
          return realEmit.call(this, name, ...values);
        };
        const realKill = child.kill;
        child.kill = function (...values) {
          evidence.killCalls += 1;
          assert.ok(Number.isInteger(this.pid) && this.pid > 0, 'never kill a child without a PID');
          return realKill.apply(this, values);
        };
        return child;
      };
      syncBuiltinESMExports();
    `;
    const result = spawnSync(process.execPath, [
      '--unhandled-rejections=strict', '--import', `data:text/javascript,${encodeURIComponent(hook)}`,
      path.join(directory, 'scripts', 'e2e-web.mjs'),
    ], {
      cwd: directory,
      env: { ...process.env, NODE_OPTIONS: '', LAB_BROWSER: executable, TMPDIR: profiles, TMP: profiles, TEMP: profiles },
      encoding: 'utf8', timeout: 30000, windowsHide: true,
    });
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(existsSync(evidenceFile), result.stderr);
    const evidence = JSON.parse(readFileSync(evidenceFile, 'utf8'));
    t.diagnostic(JSON.stringify(evidence));
    assert.equal(evidence.spawnCalls, 1);
    assert.equal(evidence.existedAtSpawn, true);
    if (failure === 'removed executable') {
      assert.equal(evidence.removedBeforeSpawn, true);
      assert.equal(evidence.pid, null);
      assert.equal(evidence.errorCode, 'ENOENT');
      assert.ok(evidence.errorListenersAtEmit > 0, 'listener must exist before the native error event');
      assert.deepEqual(evidence.listeners, { error: 0, exit: 0, close: 0 });
    } else {
      assert.equal(evidence.synchronous, true);
      assert.equal(evidence.errorCode, 'ERR_INVALID_ARG_VALUE');
    }
    assert.equal(evidence.reportExists, true, `startup failure must write e2e.json: ${result.stderr.slice(0, 500)}`);
    const report = JSON.parse(readFileSync(reportFile, 'utf8'));
    assert.equal(report.ok, false);
    assert.equal(report.full, false);
    assert.equal(report.requested.length, harness.SECTIONS.length);
    assert.deepEqual(report.executed, []);
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].name, 'harness');
    assert.equal(report.results[0].ok, false);
    assert.match(report.results[0].detail, /no browser produced a DevTools port/);
    assert.ok(report.results[0].detail.includes(executable));
    assert.match(report.results[0].detail, failure === 'removed executable' ? /ENOENT/ : /null bytes/);
    assert.equal(evidence.profileExists, false, 'failed attempt must remove its profile');
    assert.equal(evidence.killCalls, 0, 'failed spawn has no process to kill');
    assert.ok(evidence.elapsedMs < 3000, `no PID must not wait for exit or leave polling alive: ${evidence.elapsedMs}ms`);
    assert.doesNotMatch(result.stderr, /Unhandled|unhandledRejection|uncaught/i);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  }
}

for (const failure of ['removed executable', 'invalid spawn argument']) {
  // These cases assert the kernel's ENOENT timing and listener counts. macOS
  // emits the error asynchronously through a different path; the product path
  // stays covered by the Linux and Windows jobs.
  test(`CLI reports and cleans up native spawn failure: ${failure}`,
    { skip: process.platform === 'darwin' ? 'native spawn-failure timings are asserted on Linux and Windows' : false },
    (t) => nativeSpawnFailure(t, failure));
}
