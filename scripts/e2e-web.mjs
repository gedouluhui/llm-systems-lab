import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildWeb } from './build-web.mjs';
import { createStaticServer } from './serve-web.mjs';
import { browserCandidates } from './browser-discovery.mjs';
import { productChecks } from './e2e-product.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(PROJECT_ROOT, 'artifacts', 'a2');
const DIST = path.join(PROJECT_ROOT, 'apps', 'web', 'dist');

export const SECTIONS = [
  'load',
  'baseline',
  'worker',
  'intent',
  'worker-errors',
  'input',
  'fault',
  'work',
  'step',
  'cache',
  'paging',
  'language',
  'export',
  'xss',
  'a11y',
  'narrow',
  'motion',
  'product',
  'perf',
  'resources',
];

/**
 * A green report requires the full ordered section set, one result per
 * section, and every result passing. `--only` runs are debugging aids: they
 * carry `full: false` and can never be accepted as acceptance evidence.
 */
export function summarizeReport(requested, results) {
  const executed = results.map((result) => result.name);
  const full = requested.length === SECTIONS.length
    && SECTIONS.every((name) => requested.includes(name));
  const complete = SECTIONS.every((name) => executed.includes(name));
  return {
    ok: full && complete && results.length === SECTIONS.length
      && results.every((result) => result.ok),
    full,
    requested: [...requested],
    executed,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseDevToolsActivePort(text) {
  if (typeof text !== 'string') {
    throw new Error('DevToolsActivePort must be text');
  }
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) {
    throw new Error('DevToolsActivePort is malformed');
  }
  const portText = lines[0].trim();
  const wsPath = lines[1].trim();
  if (!/^\d+$/.test(portText) || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(wsPath)) {
    throw new Error('DevToolsActivePort is malformed');
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('DevToolsActivePort is malformed');
  }
  return { port, wsPath };
}

export function isLocalResource(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

export function createCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = new WebSocket(wsUrl);
    } catch (error) {
      reject(error);
      return;
    }
    let nextId = 1;
    let closed = false;
    const pending = new Map();
    const listeners = new Set();

    const rejectPending = (error) => {
      for (const entry of pending.values()) {
        entry.reject(error);
      }
      pending.clear();
    };

    socket.addEventListener('open', () => {
      resolve({
        send(method, params = {}, sessionId) {
          if (closed) {
            return Promise.reject(new Error('CDP socket is closed'));
          }
          const id = nextId;
          nextId += 1;
          return new Promise((resolveSend, rejectSend) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectSend(new Error(`CDP timeout: ${method}`));
            }, 30000);
            pending.set(id, {
              resolve: (value) => {
                clearTimeout(timer);
                resolveSend(value);
              },
              reject: (error) => {
                clearTimeout(timer);
                rejectSend(error);
              },
            });
            socket.send(JSON.stringify({ id, method, params, sessionId }));
          });
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        close() {
          if (closed) {
            return;
          }
          closed = true;
          rejectPending(new Error('CDP socket closed'));
          try {
            socket.close();
          } catch {
            // Already closing.
          }
        },
      });
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        return;
      }
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof message.id === 'number') {
        const entry = pending.get(message.id);
        if (entry !== undefined) {
          pending.delete(message.id);
          if (message.error) {
            entry.reject(new Error(`${message.error.message} (${message.error.code})`));
          } else {
            entry.resolve(message.result);
          }
        }
        return;
      }
      for (const listener of [...listeners]) {
        try {
          listener(message);
        } catch {
          // A listener failure must not break message routing.
        }
      }
    });

    socket.addEventListener('error', () => {
      if (!closed) {
        closed = true;
        reject(new Error('CDP WebSocket failed to connect'));
        rejectPending(new Error('CDP WebSocket failed'));
      }
    });

    socket.addEventListener('close', () => {
      closed = true;
      rejectPending(new Error('CDP socket closed'));
    });
  });
}

// Call immediately after spawn, and await ready before yielding elsewhere.
// Keep the error guard through shutdown; the owner must dispose on every path.
export function watchBrowserStartup(profile, child) {
  const file = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 15000;
  let timer;
  let onError;
  const ready = new Promise((resolve, reject) => {
    onError = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    child.on('error', onError);
    const poll = () => {
      if (Date.now() >= deadline) {
        onError(new Error('timed out waiting for DevToolsActivePort'));
        return;
      }
      try {
        resolve(parseDevToolsActivePort(readFileSync(file, 'utf8')));
        return;
      } catch {
        // Not written yet.
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        onError(new Error(`browser exited before DevTools was ready (code ${child.exitCode}, signal ${child.signalCode})`));
        return;
      }
      timer = setTimeout(poll, 100);
    };
    poll();
  });
  return {
    ready,
    dispose() {
      clearTimeout(timer);
      child.off('error', onError);
    },
  };
}

async function fetchPageTarget(port) {
  const deadline = Date.now() + 10000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      if (Array.isArray(targets) && targets.length > 0) {
        const page = targets.find((target) => target.type === 'page');
        if (page !== undefined && typeof page.webSocketDebuggerUrl === 'string') {
          return page;
        }
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`no page target after DevTools start${lastError === null ? '' : `: ${lastError.message}`}`);
}

function browserUserAgent(version) {
  const product = typeof version.product === 'string' ? version.product : 'unknown';
  return `${product} (headless)`;
}

async function waitForChildExit(child, timeoutMs) {
  // A failed spawn has no PID and will never emit exit. Never wait or kill it.
  if (!Number.isInteger(child.pid) || child.pid <= 0
    || child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return new Promise((resolve) => {
    const onExit = () => finish(true);
    const finish = (value) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

async function closeServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function removeProfile(profile) {
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  } catch {
    // A leftover temp profile is not a test result.
  }
}

/**
 * Boots one headless browser against the built static bundle and runs the
 * requested UI sections in order. A section failure never stops later
 * sections; the caller receives every result.
 */
export async function runE2E(options = {}) {
  const requested = options.sections ?? SECTIONS;
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new Error('runE2E requires at least one section');
  }
  for (const name of requested) {
    if (!SECTIONS.includes(name)) {
      throw new Error(`unknown e2e section "${name}"`);
    }
  }

  const candidates = browserCandidates();
  mkdirSync(ARTIFACTS, { recursive: true });
  buildWeb();
  const results = [];
  const screenshots = [];
  let profile = '';
  let child = null;
  let browserStartup = null;
  let server = null;
  let cdp = null;
  let userAgent = 'unknown';
  let origin = '';

  const consoleErrors = [];
  const exceptions = [];
  const externalRequests = [];

  try {
    let port = null;
    const launchErrors = [];
    for (const candidate of candidates) {
      const attemptProfile = mkdtempSync(path.join(tmpdir(), 'llm-systems-lab-e2e-'));
      let attempt = null;
      let startup = null;
      try {
        attempt = spawn(candidate, [
          '--headless=new',
          '--disable-gpu',
          '--hide-scrollbars',
          '--no-first-run',
          '--no-default-browser-check',
          `--user-data-dir=${attemptProfile}`,
          '--remote-debugging-port=0',
          'about:blank',
        ], { stdio: 'ignore', windowsHide: true });
        startup = watchBrowserStartup(attemptProfile, attempt);
        const ready = await startup.ready;
        profile = attemptProfile;
        child = attempt;
        browserStartup = startup;
        port = ready.port;
        break;
      } catch (error) {
        launchErrors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
        if (attempt !== null) {
          const exited = await waitForChildExit(attempt, 3000);
          if (!exited) {
            try {
              attempt.kill();
            } catch {
              // Already gone.
            }
            await waitForChildExit(attempt, 2000);
          }
        }
      } finally {
        // The outer finally owns only the successful attempt.
        if (profile !== attemptProfile) {
          startup?.dispose();
          await removeProfile(attemptProfile);
        }
      }
    }
    if (port === null) {
      throw new Error(`no browser produced a DevTools port: ${launchErrors.join(' | ')}`);
    }

    const page = await fetchPageTarget(port);
    cdp = await createCdp(page.webSocketDebuggerUrl);

    cdp.onEvent((message) => {
      if (message.method === 'Runtime.exceptionThrown') {
        const description = message.params?.exceptionDetails?.exception?.description
          ?? message.params?.exceptionDetails?.text
          ?? 'uncaught exception';
        exceptions.push(String(description));
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        const type = message.params?.type;
        if (type === 'error' || type === 'assert') {
          const values = Array.isArray(message.params?.args) ? message.params.args : [];
          consoleErrors.push(values.map((arg) => String(arg.value ?? arg.description ?? '')).join(' '));
        }
      }
      if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
        consoleErrors.push(String(message.params.entry.text ?? 'log error'));
      }
      if (message.method === 'Network.requestWillBeSent') {
        const url = message.params?.request?.url;
        if (typeof url === 'string' && /^https?:/i.test(url) && !isLocalResource(url, origin)) {
          externalRequests.push(url);
        }
      }
    });

    await cdp.send('Page.enable');
    try {
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch {
      // Focus emulation is an a11y-test aid; carry on if this browser lacks it.
    }
    try {
      await cdp.send('Page.setDownloadBehavior', { behavior: 'deny' });
    } catch {
      // Older browsers may reject the deprecated domain; downloads stay out of the repo either way.
    }
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    // Each dedicated worker loads modules. The browser's default 250-entry
    // buffer would silently drop later transfers and undercount this suite.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "performance.setResourceTimingBufferSize(10000); window.__resourceTimingOverflow = false; performance.addEventListener('resourcetimingbufferfull', () => { window.__resourceTimingOverflow = true; });",
    });
    const version = await cdp.send('Browser.getVersion');
    userAgent = browserUserAgent(version);

    server = createStaticServer(DIST);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('static server did not expose a port');
    }
    origin = `http://127.0.0.1:${address.port}`;

    async function evaluate(expression) {
      const response = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (response !== null && typeof response === 'object' && response.exceptionDetails) {
        const details = response.exceptionDetails;
        throw new Error(details.exception?.description ?? details.text ?? 'page evaluation failed');
      }
      return response?.result?.value;
    }

    async function waitFor(expression, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) {
          return;
        }
        await delay(50);
      }
      throw new Error(`timed out waiting for: ${expression}`);
    }

    async function click(selector) {
      const clicked = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el === null) return false;
        for (let parent = el.parentElement; parent; parent = parent.parentElement) {
          if (parent instanceof HTMLDetailsElement) parent.open = true;
        }
        el.click();
        return true;
      })()`);
      if (clicked !== true) {
        throw new Error(`missing element: ${selector}`);
      }
    }

    async function setValue(selector, value) {
      const applied = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el === null) return false;
        for (let parent = el.parentElement; parent; parent = parent.parentElement) {
          if (parent instanceof HTMLDetailsElement) parent.open = true;
        }
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : el instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, ${JSON.stringify(String(value))});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      if (applied !== true) {
        throw new Error(`missing element: ${selector}`);
      }
    }

    async function text(selector) {
      return evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return el === null ? null : (el.textContent ?? '').trim();
      })()`);
    }

    async function attr(selector, name) {
      return evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return el === null ? null : el.getAttribute(${JSON.stringify(name)});
      })()`);
    }

    async function count(selector) {
      return evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
    }

    async function screenshot(name) {
      const response = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const file = path.join(ARTIFACTS, name);
      writeFileSync(file, Buffer.from(response.data, 'base64'));
      screenshots.push(name);
      return file;
    }

    async function setViewport(width, height) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }

    async function setFault(fault) {
      await click(`input[name="fault"][value="${fault}"]`);
    }

    async function runAndWait(timeoutMs = 15000) {
      const before = await evaluate('window.__lab?.runCount ?? 0');
      await click('#run-button');
      await waitFor(`(window.__lab?.runCount ?? 0) > ${before}`, timeoutMs);
      await waitFor(`document.querySelector('#status-lamp')?.dataset.state !== 'running'`, 5000);
      return attr('#status-lamp', 'data-state');
    }

    async function runWithValidInput({ tokens, seed = 7, fault = 'none' } = {}) {
      if (tokens !== undefined) {
        await setValue('#tokens-input', tokens);
      }
      await setValue('#seed-input', String(seed));
      await setFault(fault);
      return runAndWait();
    }

    async function lastResult() {
      return evaluate('window.__lab?.lastResult ?? null');
    }

    async function expect(condition, message) {
      if (!condition) {
        throw new Error(message);
      }
    }

    async function gotoApp() {
      await cdp.send('Page.navigate', { url: `${origin}/` });
      await waitFor("document.readyState === 'complete' && window.__lab?.ready === true", 15000);
    }

    const workerTargets = [];
    const attachedWorkers = new Map();
    cdp.onEvent((message) => {
      if (['Target.targetCreated', 'Target.targetInfoChanged'].includes(message.method)
        && message.params.targetInfo.type === 'worker') {
        const info = message.params.targetInfo;
        const index = workerTargets.findIndex((target) => target.targetId === info.targetId);
        if (index === -1) workerTargets.push(info);
        else workerTargets[index] = info;
      }
      if (message.method === 'Target.attachedToTarget' && message.params.targetInfo.type === 'worker') {
        attachedWorkers.set(message.params.sessionId, message.params.targetInfo);
      }
      if (message.method === 'Target.detachedFromTarget') attachedWorkers.delete(message.params.sessionId);
    });
    await cdp.send('Target.setDiscoverTargets', { discover: true });

    async function holdWorker(action) {
      await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      await action();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && attachedWorkers.size === 0) await delay(20);
      const session = attachedWorkers.keys().next().value;
      await expect(session !== undefined, 'no actual CDP Worker target was attached');
      return session;
    }
    async function releaseWorkers() {
      for (const session of attachedWorkers.keys()) {
        await cdp.send('Runtime.runIfWaitingForDebugger', {}, session).catch(() => {});
      }
      await cdp.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
    }
    const docFor = (seed, tokens = [1, 2, 3]) => ({
      schemaVersion: 1, kind: 'llm-systems-lab.experiment',
      input: { schemaVersion: 1, seed, tokens, fault: 'none' },
      paging: { pageSize: 8, pageCount: 3, operations: [{ op: 'append', id: 'imported', tokens: 9 }] },
    });

    const handlers = {
      async product() {
        await gotoApp();
        return productChecks({ evaluate, click, setValue, waitFor, expect, cdp, screenshot, setViewport, holdWorker, releaseWorkers });
      },
      async load() {
        await gotoApp();
        await setViewport(1280, 900);
        await waitFor("document.querySelector('#run-button') !== null", 5000);
        await expect(await evaluate("document.querySelectorAll('h1').length === 1"), 'expected exactly one h1');
        await expect(await count('#scenario-form') === 1, 'missing #scenario-form');
        await expect(await count('#capture') === 1, 'missing #capture');
        await expect(await count('#summary') === 1, 'missing #summary');
        await expect(await count('#step-table') === 1, 'missing #step-table');
        await expect(await count('#page-map') === 1, 'missing #page-map');
        await expect(await count('#export-button') === 1, 'missing #export-button');
        await expect(await count('#lang-button') === 1, 'missing #lang-button');
        const csp = await evaluate("document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]')?.content ?? ''");
        await expect(typeof csp === 'string' && csp.includes("default-src 'self'"), 'CSP meta tag missing');
        await screenshot('desktop.png');
        return 'shell ready at 1280x900';
      },

      async baseline() {
        await setViewport(1280, 900);
        const lamp = await runWithValidInput({ tokens: '1,4,2,8,3,9', seed: 7, fault: 'none' });
        await expect(lamp === 'pass', `expected pass lamp, got ${lamp}`);
        const result = await lastResult();
        await expect(result !== null && result.comparison.passes === true, 'lastResult is not a passing run');
        await expect(result.comparison.stepsCompared === 6, 'expected 6 compared steps');
        await expect(result.comparison.firstDivergence === null, 'expected no divergence');
        await expect(result.model.weightsSha256.startsWith('75384d2cbebc'), 'unexpected seed-7 fingerprint');
        await expect(await count('#capture button.capture-col') === 6, 'expected six capture columns');
        await expect(await count('#capture button.capture-col .lane') === 12,
          'expected two per-layer lanes in every capture column');
        const laneInfo = (position) => evaluate(`(() => {
          const column = document.querySelector('#capture button.capture-col[data-position="${position}"]');
          if (column === null) {
            return null;
          }
          return {
            label: column.getAttribute('aria-label'),
            lanes: Array.from(column.querySelectorAll('.lane')).map((lane) => ({
              layer: lane.dataset.layer,
              readMarks: lane.querySelectorAll('.mark-read').length,
              count: lane.querySelector('.mark-count')?.textContent ?? null,
            })),
          };
        })()`);
        const atOne = await laneInfo(1);
        await expect(atOne !== null && atOne.lanes.length === 2, 'position 1 is missing layers');
        await expect(
          atOne.lanes.every((lane) => lane.readMarks === 1 && lane.count === 'R2'),
          `position 1 read counts: ${JSON.stringify(atOne.lanes)}`,
        );
        await expect(
          /layer 0: 1 writes?, 2 reads/i.test(atOne.label)
            && /layer 1: 1 writes?, 2 reads/i.test(atOne.label),
          `position 1 label: ${atOne.label}`,
        );
        const atTwo = await laneInfo(2);
        await expect(atTwo !== null && atTwo.lanes.length === 2, 'position 2 is missing layers');
        await expect(
          atTwo.lanes.every((lane) => lane.readMarks === 1 && lane.count === 'R3'),
          `position 2 read counts: ${JSON.stringify(atTwo.lanes)}`,
        );
        await expect(await count('#step-table tbody tr') === 6, 'expected six step rows');
        const compute = await text('#summary [data-field="compute"]');
        await expect(compute !== null && /ms/.test(compute), `compute field missing milliseconds: ${compute}`);
        const fingerprint = await text('#summary [data-field="fingerprint"]');
        await expect(fingerprint !== null && fingerprint.startsWith('75384d2cbebc'), `fingerprint field: ${fingerprint}`);
        return 'seed 7, six tokens: PASS with no divergence';
      },

      async worker() {
        const before = await evaluate('window.__lab.runCount');
        await setValue('#tokens-input', '1,4,2,8,3,9');
        await setValue('#seed-input', '7');
        try {
          const session = await holdWorker(() => click('#run-button'));
          const context = await cdp.send('Runtime.evaluate', {
            expression: "typeof document === 'undefined' && self instanceof DedicatedWorkerGlobalScope",
            returnByValue: true,
          }, session);
          await expect(context.result.value === true, 'target is not a dedicated worker global');
          await expect(await evaluate('window.__lab.runCount') === before, 'run finished while its Worker was paused');
          await setValue('#page-size', '16');
          await setValue('#page-count', '4');
          await setValue('#request-id', 'interactive');
          await setValue('#append-tokens', '1');
          await click('#append-button');
          await expect(await text('#paging-summary [data-field="used-pages"]') === '1', 'paging blocked during work');
          await click('#lang-button');
          await expect(await attr('html', 'lang') === 'zh', 'language blocked during work');
          await expect(await text('#run-status') === '运行中…', 'language change lost pending status');
          await click('#lang-button');
        } finally { await releaseWorkers(); }
        await waitFor(`window.__lab.runCount === ${before + 1}`);
        const observed = await evaluate('window.__lab');
        await expect(workerTargets.some((target) => target.url.endsWith('/experiment-worker.js')),
          `no module worker target observed: ${JSON.stringify(workerTargets)}; attached=${JSON.stringify([...attachedWorkers])}`);
        for (const key of ['fullForwardMs', 'cachedDecoderMs', 'totalMs', 'roundTripMs']) {
          await expect(Number.isFinite(observed[key]) && observed[key] >= 0, `invalid ${key}`);
        }
        await expect(observed.totalMs >= observed.fullForwardMs + observed.cachedDecoderMs, 'invalid kernel total');
        await expect(observed.lastRunMs === observed.roundTripMs && observed.roundTripMs >= observed.totalMs,
          'round-trip does not include core time');
        const { runExperiment } = await import(pathToFileURL(path.join(DIST, 'packages/core/index.js')).href);
        for (const fault of ['none', 'position-offset', 'cache-overwrite', 'mask-current-only', 'no-cache-recompute']) {
          await runWithValidInput({ tokens: '1,4,2,8,3,9', seed: 7, fault });
          const actual = await lastResult();
          const expected = await runExperiment({ schemaVersion: 1, seed: 7, tokens: [1,4,2,8,3,9], fault });
          await expect(JSON.stringify(actual) === JSON.stringify(expected), `${fault} Worker result differs from core`);
          await expect(!Object.hasOwn(actual, 'timing'), 'timing leaked into report JSON');
        }
        await runWithValidInput({ tokens: '1,4,2,8,3,9', fault: 'none' });
        return `CDP dedicated Worker observed (${workerTargets.length} targets); all faults byte-equal; paging/language usable while worker paused`;
      },

      async intent() {
        // All intents in one browser task: earlier promises cannot complete first.
        const attempt = (kind, value) => kind === 'run'
          ? `document.querySelector('#seed-input').value = ${JSON.stringify(String(value))}; document.querySelector('#run-button').click();`
          : `document.querySelector('#import-input').value = ${JSON.stringify(typeof value === 'string' ? value : JSON.stringify(value))}; document.querySelector('#import-button').click();`;
        for (const [first, second, seed] of [
          [['run', 11], ['run', 12], 12],
          [['run', 13], ['import', docFor(14)], 14],
          [['import', docFor(15)], ['run', 16], 16],
          [['import', docFor(17)], ['import', docFor(18)], 18],
        ]) {
          const before = await evaluate('window.__lab.runCount');
          await evaluate(`(() => { ${attempt(...first)} ${attempt(...second)} })()`);
          await waitFor(`window.__lab.lastInput.seed === ${seed}`);
          await expect(await evaluate('window.__lab.runCount') === before + 1, 'superseded result incremented runCount');
        }
        for (const first of [['run', 21], ['import', docFor(22)]]) {
          for (const invalid of [['run', 'bad'], ['import', '{']]) {
            const before = await evaluate('JSON.stringify(window.__lab.lastResult)');
            const beforeCount = await evaluate('window.__lab.runCount');
            await evaluate(`(() => { ${attempt(...first)} ${attempt(...invalid)} })()`);
            const selector = invalid[0] === 'run' ? '#run-status' : '#import-status';
            await waitFor(`document.querySelector(${JSON.stringify(selector)}).textContent.includes('INPUT')`);
            // Cross several browser tasks after cancellation to expose stale catch/success paths.
            await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
            await expect(await evaluate('JSON.stringify(window.__lab.lastResult)') === before, 'invalid latest intent allowed stale result');
            await expect(await evaluate('window.__lab.runCount') === beforeCount, 'invalid latest intent changed runCount');
            await expect(!(await text('#run-status')).includes('CANCELLED'), 'stale cancellation polluted UI');
          }
        }
        await runWithValidInput({ tokens: '1,4,2,8,3,9', seed: 7 });
        const doc = docFor(23);
        await setValue('#import-input', JSON.stringify(doc));
        const before = await evaluate(`({ count: window.__lab.runCount, seed: document.querySelector('#seed-input').value,
          pages: document.querySelector('#page-map').innerHTML, size: document.querySelector('#page-size').value })`);
        try {
          await holdWorker(() => click('#import-button'));
          const pending = await evaluate(`({ count: window.__lab.runCount, seed: document.querySelector('#seed-input').value,
            pages: document.querySelector('#page-map').innerHTML, size: document.querySelector('#page-size').value })`);
          await expect(JSON.stringify(pending) === JSON.stringify(before), 'import partially committed before its result');
        } finally { await releaseWorkers(); }
        await waitFor('window.__lab.lastInput.seed === 23');
        await expect(await evaluate("document.querySelector('#seed-input').value") === '23', 'import did not commit controls');
        await expect(await text('#paging-summary [data-field="used-pages"]') === '2', 'import did not commit paging');
        try {
          await holdWorker(() => click('#run-button'));
          await evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));");
          await expect(await attr('#status-lamp', 'data-state') !== 'running', 'pagehide cancelled work but left a permanent running state');
          await expect(!(await text('#run-status')).includes('CANCELLED'), 'pagehide leaked stale cancellation');
        } finally { await releaseWorkers(); }
        await runWithValidInput({ tokens: '1,4,2,8,3,9', seed: 7 });
        return 'run/import ordering, invalid newer intents, stale errors, atomic import and page lifecycle cancellation verified';
      },

      async 'worker-errors'() {
        // Failure injection is confined to this isolated test page's transport;
        // recovery must execute the original browser Worker and real numerics.
        const countBefore = await evaluate('window.__lab.runCount');
        await evaluate(`(() => { window.__savedWorker = window.Worker;
          window.Worker = class { constructor() { throw new Error('C:/private/startup'); } };
          document.querySelector('#run-button').click(); })()`);
        try {
          await waitFor("document.querySelector('#run-status').textContent.includes('WORKER_START')");
          await expect(!(await text('#run-status')).includes('private'), 'startup leaked a local path');
          await expect(await evaluate('window.__lab.runCount') === countBefore, 'failure changed runCount');
        } finally { await evaluate('window.Worker = window.__savedWorker; delete window.__savedWorker'); }
        await runWithValidInput({ tokens: '1,4,2,8,3,9', seed: 7 });
        const errorReply = await evaluate(`new Promise((resolve, reject) => {
          const worker = new Worker('./apps/web/src/experiment-worker.js', { type: 'module' });
          const timer = setTimeout(() => { worker.terminate(); reject(Error('worker error reply timeout')); }, 5000);
          worker.onmessage = event => { clearTimeout(timer); worker.terminate(); resolve(event.data); };
          worker.onerror = () => { clearTimeout(timer); worker.terminate(); reject(Error('worker failed')); };
          worker.postMessage({ kind: 'run', id: 91, input: null });
        })`);
        await expect(errorReply.kind === 'error' && errorReply.id === 91 && errorReply.error.code === 'INPUT',
          'real worker did not reject malformed input');
        await expect(!/stack|private/.test(errorReply.error.message), 'worker error leaked exception details');
        return 'startup failure is visible and sanitized; next real Worker recovers; worker rejects invalid input';
      },

      async input() {
        await setValue('#tokens-input', '1, ,2');
        await setValue('#seed-input', '7');
        await setFault('none');
        const before = await evaluate('window.__lab?.runCount ?? 0');
        await click('#run-button');
        await waitFor("document.querySelector('#run-status')?.textContent?.includes('INPUT') === true", 5000);
        await expect(await evaluate('window.__lab?.runCount ?? 0') === before, 'invalid input incremented runCount');
        await expect(await attr('#status-lamp', 'data-state') === 'fail', 'invalid input did not set fail lamp');
        await expect(await count('#capture button.capture-col') === 6,
          'invalid input changed the displayed capture');
        await setValue('#tokens-input', Array.from({ length: 65 }, () => '1').join(','));
        await click('#run-button');
        await waitFor("document.querySelector('#run-status')?.textContent?.includes('64') === true", 5000);
        await expect(await count('#capture button.capture-col') === 6,
          'oversized token list changed the displayed capture');
        const lamp = await runWithValidInput({ tokens: '1,2,3', seed: 7, fault: 'none' });
        await expect(lamp === 'pass', `recovery run did not pass: ${lamp}`);
        const recovery = await lastResult();
        await expect(recovery !== null && recovery.comparison.stepsCompared === 3,
          'three-token run did not compare three steps');
        await expect(await count('#capture button.capture-col') === 3,
          'capture did not shrink to three columns after a token edit');
        await expect(await count('#step-table tbody tr') === 3,
          'step table did not shrink to three rows after a token edit');
        await expect(await text('#summary [data-field="first-divergence"]') === '—',
          'clean run did not show an em dash for first divergence');
        const lamp6 = await runWithValidInput({ tokens: '1,4,2,8,3,9', seed: 7, fault: 'none' });
        await expect(lamp6 === 'pass', `six-token rerun did not pass: ${lamp6}`);
        const expanded = await lastResult();
        await expect(expanded !== null && expanded.comparison.stepsCompared === 6,
          'six-token run did not compare six steps');
        await expect(await count('#capture button.capture-col') === 6,
          'capture did not grow back to six columns');
        await expect(await count('#step-table tbody tr') === 6,
          'step table did not grow back to six rows');
        const expectedFingerprint = `${expanded.model.weightsSha256.slice(0, 12)}…`;
        await expect(await text('#summary [data-field="fingerprint"]') === expectedFingerprint,
          'summary fingerprint does not match the fresh result');
        await expect(await text('#summary [data-field="engine"]') === expanded.engineVersion,
          'summary engine does not match the fresh result');
        const shownAbs = Number.parseFloat(await text('#summary [data-field="max-abs"]'));
        const expectedAbs = expanded.comparison.maxAbsoluteError;
        await expect(
          Number.isFinite(shownAbs)
            && Math.abs(shownAbs - expectedAbs) <= Math.max(1e-12, Math.abs(expectedAbs) * 2e-3),
          `summary max |Δ| ${shownAbs} does not match ${expectedAbs}`,
        );
        return 'invalid input is inert and valid token edits re-render capture, rows and summary';
      },

      async fault() {
        for (const faultName of ['position-offset', 'cache-overwrite', 'mask-current-only']) {
          const lamp = await runWithValidInput({ tokens: '1,4,2,8,3,9', seed: 7, fault: faultName });
          await expect(lamp === 'fail', `${faultName} did not fail the lamp`);
          const result = await lastResult();
          await expect(result !== null && result.input.fault === faultName, `${faultName} result missing`);
          await expect(result.comparison.firstDivergence !== null && result.comparison.firstDivergence >= 1,
            `${faultName} diverged before position 1`);
          const divergedAt = String(result.comparison.firstDivergence);
          await expect(await attr(`#capture button.capture-col[data-position="${divergedAt}"]`, 'class') !== null,
            `${faultName} capture column missing`);
          await expect(await evaluate(`document.querySelector('#capture button.capture-col[data-position="${divergedAt}"]')?.classList.contains('is-diverged') === true`),
            `${faultName} capture column not marked diverged`);
          await evaluate("document.querySelector('#capture')?.scrollIntoView({ block: 'center' })");
          await delay(120);
          await screenshot(`fault-${faultName}.png`);
        }
        const lamp = await runWithValidInput({ tokens: '1,4,2,8,3,9', seed: 7, fault: 'none' });
        await expect(lamp === 'pass', 'baseline did not return to PASS');
        return 'all three teaching faults caught at position 1 or later';
      },

      async work() {
        await setFault('no-cache-recompute');
        const teaching = await text('#fault-teaching');
        await expect(teaching !== null && teaching.includes('No-cache recompute'),
          `fault teaching did not follow the fifth mode: ${teaching}`);
        const lamp = await runWithValidInput({ tokens: '1,4,2,8,3,9', seed: 7, fault: 'no-cache-recompute' });
        await expect(lamp === 'pass', `no-cache recompute did not pass numerically: ${lamp}`);
        const result = await lastResult();
        await expect(result !== null && result.input.fault === 'no-cache-recompute',
          'no-cache recompute result missing');
        await expect(result.comparison.passes === true && result.comparison.firstDivergence === null,
          'no-cache recompute diverged numerically');
        await expect(result.workSummary.totalRecomputeTokens === 21,
          `no-cache ledger recomputed ${result.workSummary.totalRecomputeTokens} tokens`);
        await expect(await text('#summary [data-field="work-class"]') === 'O(T^2) step / O(T^3) total',
          `no-cache complexity row: ${await text('#summary [data-field="work-class"]')}`);
        await expect(await text('#summary [data-field="work-tokens"]') === '21 / 6',
          `no-cache token ledger: ${await text('#summary [data-field="work-tokens"]')}`);
        await expect(await text('#summary [data-field="work-kv"]') === '112',
          `no-cache KV row: ${await text('#summary [data-field="work-kv"]')}`);
        await expect(await text('#summary [data-field="work-attention"]') === '3584',
          `no-cache attention row: ${await text('#summary [data-field="work-attention"]')}`);
        await expect(await attr('#work-note', 'data-state') === 'degraded',
          'work note did not flag the degraded path');
        const note = await text('#work-note');
        await expect(note !== null && /bypassed/i.test(note), `work note text: ${note}`);
        await evaluate("document.querySelector('#summary')?.scrollIntoView({ block: 'center' })");
        await delay(120);
        await screenshot('work-no-cache.png');
        const clean = await runWithValidInput({ tokens: '1,4,2,8,3,9', seed: 7, fault: 'none' });
        await expect(clean === 'pass', `baseline after no-cache did not pass: ${clean}`);
        await expect(await text('#summary [data-field="work-class"]') === 'O(T) step / O(T^2) total',
          'cached baseline did not report the cached complexity class');
        await expect(await text('#summary [data-field="work-tokens"]') === '6 / 6',
          'cached baseline token ledger is wrong');
        await expect(await text('#summary [data-field="work-kv"]') === '42',
          'cached baseline KV ledger is wrong');
        await expect(await text('#summary [data-field="work-attention"]') === '1344',
          'cached baseline attention ledger is wrong');
        await expect(await attr('#work-note', 'data-state') === 'ok',
          'work note did not return to the cached verdict');
        return 'no-cache recompute passes numerically while the work ledger flags the O(T^2) degradation';
      },

      async step() {
        await runWithValidInput({ tokens: '1,4,2,8,3,9', seed: 7, fault: 'none' });
        await click('#step-table tbody button.step-select[data-position="1"]');
        await waitFor("document.querySelector('#capture button.capture-col[data-position=\"1\"]')?.getAttribute('aria-current') === 'step'", 5000);
        const detail = await text('#step-detail');
        await expect(detail !== null && /layer 0/i.test(detail) && /layer 1/i.test(detail), `step detail missing layers: ${detail}`);
        await expect(/logits/i.test(detail), 'step detail missing logits comparison');
        await click('#capture button.capture-col[data-position="3"]');
        await waitFor("document.querySelector('#capture button.capture-col[data-position=\"3\"]')?.classList.contains('is-selected') === true", 5000);
        const second = await text('#step-detail');
        await expect(second !== null && /position 3/i.test(second), `detail did not follow the selected column: ${second}`);
        return 'selection follows capture clicks and exposes both layers';
      },

      async cache() {
        await runWithValidInput({ tokens: '1,4,2,8,3,9', seed: 7, fault: 'cache-overwrite' });
        await expect(await count('#cache .slot') === 12, 'expected 2 layers x 6 slots');
        await expect(await evaluate("document.querySelector('#cache .slot[data-layer=\"0\"][data-slot=\"0\"]')?.classList.contains('is-overwritten') === true"),
          'slot 0 was not marked overwritten');
        const label = await attr('#cache .slot[data-layer="0"][data-slot="0"]', 'aria-label');
        await expect(typeof label === 'string' && /layer 0/i.test(label) && /slot 0/i.test(label), `slot label: ${label}`);
        await runWithValidInput({ tokens: '1,4,2,8,3,9', seed: 7, fault: 'none' });
        await expect(await count('#cache .slot.is-overwritten') === 0, 'clean run still shows overwritten slots');
        return 'overwrite visible on layer 0 slot 0 and absent on the clean path';
      },

      async paging() {
        const field = (name) => text(`#paging-summary [data-field="${name}"]`);
        await setValue('#page-size', '16');
        await setValue('#page-count', '4');
        await setValue('#request-id', 'a');
        await setValue('#append-tokens', '32');
        await click('#append-button');
        await waitFor("document.querySelector('#paging-summary [data-field=\"used-pages\"]')?.textContent?.trim() === '2'", 5000);
        await setValue('#append-tokens', '1');
        await click('#append-button');
        await waitFor("document.querySelector('#paging-summary [data-field=\"used-pages\"]')?.textContent?.trim() === '3'", 5000);
        await expect(await field('used-pages') === '3', 'used pages after 33 tokens');
        await expect(await field('free-pages') === '1', `free pages after 33 tokens: ${await field('free-pages')}`);
        await expect(await field('logical-bytes') === '8.3 KiB', `logical bytes: ${await field('logical-bytes')}`);
        await expect(await field('allocated-bytes') === '12.0 KiB', `allocated bytes: ${await field('allocated-bytes')}`);
        await expect(await field('waste-bytes') === '3.8 KiB', `waste bytes: ${await field('waste-bytes')}`);
        await expect(await field('capacity-bytes') === '16.0 KiB', `capacity bytes: ${await field('capacity-bytes')}`);
        await expect(await attr('#page-map .page-cell[data-page="0"]', 'data-owner') === 'a', 'page 0 owner is not a');
        await expect(await attr('#page-map .page-cell[data-page="3"]', 'data-owner') === '', 'page 3 should be free');
        await setValue('#request-id', 'b');
        await setValue('#append-tokens', '32');
        await click('#append-button');
        await waitFor("document.querySelector('#paging-status')?.textContent?.includes('OOM') === true", 5000);
        await expect(await field('used-pages') === '3', 'failed append changed used pages');
        await expect(await field('waste-bytes') === '3.8 KiB', 'failed append changed waste');
        await expect(await attr('#page-map .page-cell[data-page="3"]', 'data-owner') === '', 'failed append claimed a page');
        await evaluate("document.querySelector('#paging-panel')?.scrollIntoView({ block: 'start' })");
        await delay(120);
        await screenshot('paging.png');
        await setValue('#request-id', 'a');
        await click('#release-button');
        await waitFor("document.querySelector('#paging-summary [data-field=\"used-pages\"]')?.textContent?.trim() === '0'", 5000);
        await expect(await field('free-pages') === '4', `free pages after release: ${await field('free-pages')}`);
        await expect(await field('logical-bytes') === '0 B', `logical bytes after release: ${await field('logical-bytes')}`);
        await expect(await field('allocated-bytes') === '0 B', `allocated bytes after release: ${await field('allocated-bytes')}`);
        await expect(await field('waste-bytes') === '0 B', `waste bytes after release: ${await field('waste-bytes')}`);

        const operations = [];
        for (let index = 0; index < 500; index += 1) {
          operations.push({ op: 'append', id: `r${index}`, tokens: 16 });
          operations.push({ op: 'release', id: `r${index}` });
        }
        const capacityDocument = {
          schemaVersion: 1,
          kind: 'llm-systems-lab.experiment',
          input: { schemaVersion: 1, seed: 7, tokens: [1, 2, 3], fault: 'none' },
          paging: { pageSize: 16, pageCount: 64, operations },
        };
        const beforeImport = await evaluate('window.__lab?.runCount ?? 0');
        await setValue('#import-input', JSON.stringify(capacityDocument));
        await click('#import-button');
        await waitFor(`(window.__lab?.runCount ?? 0) > ${beforeImport}`, 10000);
        await waitFor("document.querySelector('#paging-summary [data-field=\"used-pages\"]')?.textContent?.trim() === '0'", 5000);
        await setValue('#request-id', 'overflow');
        await setValue('#append-tokens', '1');
        await click('#append-button');
        await waitFor("document.querySelector('#paging-status')?.textContent?.includes('1000') === true", 5000);
        await expect(await field('used-pages') === '0', 'live paging cap rejection mutated the pool');
        await setValue('#page-size', '16');
        await setValue('#page-count', '4');
        await waitFor("document.querySelector('#paging-summary [data-field=\"capacity-bytes\"]')?.textContent?.trim() === '16.0 KiB'", 5000);
        return 'exact byte accounting, atomic OOM, 1000-operation live cap and reset verified';
      },

      async language() {
        await expect(await text('#summary-heading') === 'Result summary', `summary heading (en): ${await text('#summary-heading')}`);
        await expect(await text('#detail-heading') === 'Step detail', `detail heading (en): ${await text('#detail-heading')}`);
        await expect(await text('#summary .summary-row dt') === 'Status', `status label (en): ${await text('#summary .summary-row dt')}`);
        await expect(await text('[data-copy="fullForwardTime"]') === 'Full-forward wall time', 'missing full-forward label');
        await expect(await text('[data-copy="cachedDecoderTime"]') === 'Cached-decoder wall time', 'missing decoder label');
        await click('#lang-button');
        await waitFor("document.documentElement.lang === 'zh'", 5000);
        await expect(await text('[data-copy="fullForwardTime"]') === '全量前向墙钟时间', 'missing Chinese forward label');
        await expect(await text('[data-copy="cachedDecoderTime"]') === '缓存解码墙钟时间', 'missing Chinese decoder label');
        await expect(await text('[data-copy="computeTime"]') === 'Worker 往返墙钟时间', 'missing Chinese round-trip label');
        await expect(await text('#run-button') === '运行对照', `run button copy: ${await text('#run-button')}`);
        await expect(await text('#lang-button') === 'English', 'toggle text did not switch to English');
        await expect(await text('#summary-heading') === '结果摘要', `summary heading (zh): ${await text('#summary-heading')}`);
        await expect(await text('#detail-heading') === '步骤详情', `detail heading (zh): ${await text('#detail-heading')}`);
        const statusLabel = await text('#summary .summary-row dt');
        const statusValue = await text('#summary [data-field="passes"]');
        await expect(statusLabel === '状态', `status label (zh): ${statusLabel}`);
        await expect(statusLabel !== statusValue, `status label duplicates the value: ${statusLabel}`);
        await expect(['通过', '偏差'].includes(statusValue), `summary value did not translate: ${statusValue}`);
        const explanations = await evaluate(`(() => {
          const en = document.querySelector('#explain-en');
          const zh = document.querySelector('#explain-zh');
          return {
            both: en !== null && zh !== null,
            visible: en !== null && zh !== null
              && en.hidden && !zh.hidden,
          };
        })()`);
        await expect(explanations.both === true, 'missing bilingual explanations');
        await expect(explanations.visible === true, 'explanation does not follow selected language');
        await evaluate('window.scrollTo(0, 0)');
        await delay(120);
        await screenshot('language-zh.png');
        await click('#lang-button');
        await waitFor("document.documentElement.lang === 'en'", 5000);
        await expect(await text('#run-button') === 'Run comparison', 'did not restore English chrome');
        await expect(await text('#summary-heading') === 'Result summary', 'did not restore the summary heading');
        await expect(await text('#summary .summary-row dt') === 'Status', 'did not restore the status label');
        await expect(['Pass', 'Diverged'].includes(await text('#summary [data-field="passes"]')), 'did not restore the summary value');
        return 'selected explanation language, summary/detail headings and status translate';
      },

      async export() {
        await runWithValidInput({ tokens: '1,2,3', seed: 7, fault: 'none' });
        await setValue('#page-size', '16');
        await setValue('#page-count', '4');
        await click('#export-button');
        const payload = await evaluate("document.querySelector('#export-output')?.value ?? ''");
        await expect(typeof payload === 'string' && payload.length > 0, 'export textarea is empty');
        const doc = JSON.parse(payload);
        await expect(doc.schemaVersion === 1 && doc.kind === 'llm-systems-lab.experiment', 'export header is wrong');
        await expect(Array.isArray(doc.input.tokens) && doc.input.tokens.length === 3, 'export input is wrong');
        await expect(Array.isArray(doc.paging.operations), 'export paging operations missing');
        for (const forbidden of ['steps', 'comparison', 'finalCache']) {
          await expect(!(forbidden in doc), `export contains results: ${forbidden}`);
        }
        const before = await evaluate('window.__lab?.runCount ?? 0');
        await setValue('#import-input', JSON.stringify({ ...doc, input: { ...doc.input, tokens: [1, 2, 3] } }));
        await click('#import-button');
        await waitFor(`(window.__lab?.runCount ?? 0) > ${before}`, 10000);
        const result = await lastResult();
        await expect(JSON.stringify(result.input.tokens) === JSON.stringify([1, 2, 3]), 'import did not replace the input');
        await evaluate("document.querySelector('#export-panel')?.scrollIntoView({ block: 'start' })");
        await delay(120);
        await screenshot('export.png');
        return 'export excludes results; import recomputes from the input';
      },

      async xss() {
        await evaluate('window.__xss = undefined');
        const payload = '<img src=x onerror="window.__xss=1">';
        await setValue('#request-id', payload);
        await setValue('#append-tokens', '1');
        await click('#append-button');
        await waitFor("document.querySelector('#paging-status')?.textContent?.trim().length > 0", 5000);
        await expect(await evaluate("document.querySelector('img') === null"), 'request id created an img element');
        await expect(await evaluate('window.__xss === undefined'), 'request id executed script');
        const doc = JSON.parse(await evaluate("document.querySelector('#export-output')?.value ?? '{}'"));
        await setValue('#import-input', JSON.stringify({ ...doc, note: payload }));
        await click('#import-button');
        await waitFor("document.querySelector('#import-status')?.textContent?.includes('unexpected') === true", 5000);
        await expect(await evaluate("document.querySelector('img') === null"), 'import note created an img element');
        await expect(await evaluate('window.__xss === undefined'), 'import note executed script');
        const before = await evaluate('window.__lab?.runCount ?? 0');
        await setValue('#import-input', JSON.stringify(doc));
        await click('#import-button');
        await waitFor(`(window.__lab?.runCount ?? 0) > ${before}`, 10000);
        await expect(await evaluate("document.querySelector('img') === null"), 'valid import created an img element');
        return 'markup is rejected as text and a valid import recovers';
      },

      async a11y() {
        const violations = await evaluate(`(() => {
          const problems = [];
          const nameOf = (el) => {
            const aria = el.getAttribute('aria-label');
            if (aria !== null && aria.trim().length > 0) return aria.trim();
            const labelledby = el.getAttribute('aria-labelledby');
            if (labelledby !== null) {
              const text = labelledby.split(/\\s+/)
                .map((id) => document.getElementById(id)?.textContent ?? '')
                .join(' ').trim();
              if (text.length > 0) return text;
            }
            if (el.id) {
              const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
              if (label !== null && (label.textContent ?? '').trim().length > 0) return label.textContent.trim();
            }
            const wrapping = el.closest('label');
            if (wrapping !== null && (wrapping.textContent ?? '').trim().length > 0) return wrapping.textContent.trim();
            const title = el.getAttribute('title');
            if (title !== null && title.trim().length > 0) return title.trim();
            const content = (el.textContent ?? '').trim();
            if (content.length > 0) return content;
            return '';
          };
          document.querySelectorAll('input, select, textarea, button').forEach((el) => {
            if (nameOf(el).length === 0) {
              problems.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' has no accessible name');
            }
          });
          document.querySelectorAll('button').forEach((el) => {
            if (el.getAttribute('type') !== 'button' && !(el.id === 'run-button' && el.type === 'submit' && el.form?.id === 'scenario-form')) {
              problems.push((el.id ? '#' + el.id : 'button') + ' must have type="button"');
            }
          });
          document.querySelectorAll('[tabindex]').forEach((el) => {
            const value = Number(el.getAttribute('tabindex'));
            if (Number.isFinite(value) && value > 0) problems.push('positive tabindex');
          });
          if (document.querySelectorAll('h1').length !== 1) problems.push('expected exactly one h1');
          for (const landmark of ['main', 'header', 'footer']) {
            if (document.querySelector(landmark) === null) problems.push('missing ' + landmark);
          }
          const skip = document.querySelector('a.skip-link');
          if (skip === null) {
            problems.push('missing skip link');
          } else {
            const focusables = Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]'))
              .filter((el) => el.tabIndex >= 0);
            if (focusables[0] !== skip) problems.push('skip link is not first in tab order');
          }
          return problems;
        })()`);
        await expect(Array.isArray(violations) && violations.length === 0, `a11y violations: ${JSON.stringify(violations)}`);
        const outline = await evaluate(`(() => {
          const el = document.querySelector('#run-button');
          el.focus();
          const style = getComputedStyle(el);
          return { width: parseFloat(style.outlineWidth), style: style.outlineStyle };
        })()`);
        await expect(outline.width >= 2 && outline.style !== 'none',
          `focus ring too thin: ${JSON.stringify(outline)}`);

        const semantics = await evaluate(`(() => {
          const problems = [];
          if (document.documentElement.lang !== 'en') {
            problems.push('html lang is ' + document.documentElement.lang);
          }
          ['run-status', 'paging-status', 'import-status'].forEach((id) => {
            const live = document.getElementById(id)?.getAttribute('aria-live') ?? null;
            if (live !== 'polite') problems.push(id + ' aria-live is ' + live);
          });
          const headers = Array.from(document.querySelectorAll('#step-table thead th'))
            .map((th) => th.getAttribute('scope'));
          if (headers.length !== 5 || headers.some((scope) => scope !== 'col')) {
            problems.push('table header scopes: ' + JSON.stringify(headers));
          }
          return problems;
        })()`);
        await expect(Array.isArray(semantics) && semantics.length === 0,
          `semantics: ${JSON.stringify(semantics)}`);

        const contrast = await evaluate(`(() => {
          const selectors = ['.lede', '.hint', '.panel .note', '#run-status', 'thead th', '.capture-pos'];
          const parse = (value) => {
            const match = value.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/);
            if (match === null) return null;
            return {
              r: Number(match[1]),
              g: Number(match[2]),
              b: Number(match[3]),
              a: match[4] === undefined ? 1 : Number(match[4]),
            };
          };
          const channel = (value) => {
            const v = value / 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
          };
          const luminance = (color) => 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
          const effectiveBackground = (el) => {
            let node = el;
            while (node !== null) {
              const color = parse(getComputedStyle(node).backgroundColor);
              if (color !== null && color.a > 0.99) return color;
              node = node.parentElement;
            }
            return { r: 255, g: 255, b: 255, a: 1 };
          };
          return selectors.map((selector) => {
            const el = document.querySelector(selector);
            if (el === null) return { selector, ratio: 0, error: 'missing' };
            const fg = parse(getComputedStyle(el).color);
            if (fg === null) return { selector, ratio: 0, error: 'unparsed color' };
            const bg = effectiveBackground(el);
            const a = luminance(fg);
            const b = luminance(bg);
            return { selector, ratio: Number(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2)) };
          });
        })()`);
        const lowContrast = Array.isArray(contrast) ? contrast.filter((entry) => entry.ratio < 4.5) : [{ selector: 'all', ratio: 0 }];
        await expect(Array.isArray(contrast) && lowContrast.length === 0,
          `contrast below 4.5: ${JSON.stringify(lowContrast)}`);

        await evaluate(`(() => {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          document.querySelector('.capture-col[data-position="2"]')?.focus();
        })()`);
        const focused = await evaluate("document.activeElement?.classList.contains('capture-col') === true");
        await expect(focused, 'capture column did not take focus');
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await delay(50);
        const selected = await evaluate("document.querySelector('.capture-col.is-selected')?.dataset.position ?? ''");
        await expect(selected === '2', `Enter did not select the focused column: ${selected}`);
        const current = await evaluate("document.querySelector('.capture-col[aria-current=\"step\"]')?.dataset.position ?? ''");
        await expect(current === '2', `aria-current did not follow: ${current}`);
        return 'names, landmarks, tab order, live regions, table scopes, contrast and keyboard activation verified';
      },

      async narrow() {
        const tokens = Array.from({ length: 64 }, (_, index) => index % 32).join(',');
        const lamp = await runWithValidInput({ tokens, seed: 7, fault: 'none' });
        await expect(lamp === 'pass', `dense narrow run did not pass: ${lamp}`);
        await evaluate('window.scrollTo(0, 0)');
        await setViewport(360, 800);
        await delay(150);
        const shell = await evaluate(`(() => {
          const ids = ['tokens-input', 'seed-input', 'run-button', 'summary', 'capture',
            'step-table', 'page-map', 'export-button', 'lang-button'];
          return ids.map((id) => {
            const el = document.getElementById(id);
            if (el === null) {
              return { id, ok: false, reason: 'missing' };
            }
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return {
              id,
              ok: rect.width > 0 && rect.height > 0
                && style.display !== 'none' && style.visibility !== 'hidden',
              reason: 'w=' + rect.width + ' h=' + rect.height,
            };
          });
        })()`);
        const broken = shell.filter((entry) => !entry.ok);
        await expect(broken.length === 0, `unrendered shell at 360px: ${JSON.stringify(broken)}`);
        await expect(await count('#capture button.capture-col') === 64,
          'capture did not render all 64 columns at 360px');
        let overflow = await evaluate('document.documentElement.scrollWidth - window.innerWidth');
        await expect(overflow <= 1, `horizontal overflow at 360px: ${overflow}`);
        const focus = await evaluate(`(() => {
          const button = document.querySelector('#run-button');
          button.focus();
          button.scrollIntoView({ block: 'center' });
          const style = getComputedStyle(button);
          return {
            active: document.activeElement === button,
            outlineWidth: parseFloat(style.outlineWidth),
            outlineStyle: style.outlineStyle,
          };
        })()`);
        await expect(focus.active, 'run button did not take focus at 360px');
        await expect(focus.outlineWidth >= 2 && focus.outlineStyle !== 'none',
          `run button focus ring at 360px: ${JSON.stringify(focus)}`);
        await delay(120);
        await screenshot('narrow.png');
        await setViewport(375, 800);
        for (const lang of ['en', 'zh']) {
          if (await attr('html', 'lang') !== lang) await click('#lang-button');
          const timingLayout = await evaluate(`(() => {
            const fields = ['compute', 'full-forward', 'cached-decoder', 'total'];
            return fields.every(field => {
              const el = document.querySelector('#summary [data-field="' + field + '"]');
              if (!el || !el.textContent.includes('ms')) return false;
              const rect = el.parentElement.getBoundingClientRect();
              return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth;
            }) && document.documentElement.scrollWidth <= innerWidth + 1;
          })()`);
          await expect(timingLayout, `timing rows overflow or are missing at 375px (${lang})`);
          await evaluate("document.querySelector('#summary').scrollIntoView({ block: 'start' })");
          await screenshot(`timing-375-${lang}.png`);
        }
        await click('#lang-button');
        await setViewport(640, 800);
        await delay(150);
        overflow = await evaluate('document.documentElement.scrollWidth - window.innerWidth');
        await expect(overflow <= 1, `horizontal overflow at 640px: ${overflow}`);
        await setViewport(1024, 800);
        await delay(150);
        overflow = await evaluate('document.documentElement.scrollWidth - window.innerWidth');
        await expect(overflow <= 1, `horizontal overflow at 1024px: ${overflow}`);
        await setViewport(1280, 900);
        return 'shell complete, 64 columns, visible focus ring; bilingual timing at 375px; no overflow at 360/375/640/1024px';
      },

      async motion() {
        await cdp.send('Emulation.setEmulatedMedia', { features: [] });
        const before = await evaluate(`(() => {
          const lamp = document.querySelector('#status-lamp');
          if (lamp === null) {
            return null;
          }
          const previous = lamp.dataset.state;
          lamp.dataset.state = 'running';
          const probe = document.createElement('div');
          probe.id = 'motion-probe';
          probe.style.animation = 'lamp-pulse 2s linear infinite';
          probe.style.transition = 'opacity 2s linear';
          document.body.append(probe);
          const lampStyle = getComputedStyle(lamp);
          const probeStyle = getComputedStyle(probe);
          return {
            previous,
            lampName: lampStyle.animationName,
            lampDuration: lampStyle.animationDuration,
            lampIterations: lampStyle.animationIterationCount,
            probeTransition: probeStyle.transitionDuration,
          };
        })()`);
        await expect(before !== null, 'status lamp is missing');
        await expect(before.lampName === 'lamp-pulse', `normal lamp animation: ${before.lampName}`);
        await expect(before.lampDuration === '1.2s', `normal lamp duration: ${before.lampDuration}`);
        await expect(before.lampIterations === 'infinite', `normal lamp iterations: ${before.lampIterations}`);
        await expect(before.probeTransition === '2s', `normal probe transition: ${before.probeTransition}`);

        await cdp.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        });
        await delay(100);
        const reduced = await evaluate(`(() => {
          const lamp = document.querySelector('#status-lamp');
          const probe = document.querySelector('#motion-probe');
          const lampStyle = getComputedStyle(lamp);
          const probeStyle = getComputedStyle(probe);
          return {
            lampName: lampStyle.animationName,
            lampDuration: lampStyle.animationDuration,
            probeTransition: probeStyle.transitionDuration,
            probeAnimation: probeStyle.animationName,
          };
        })()`);
        await cdp.send('Emulation.setEmulatedMedia', { features: [] });
        await evaluate(`(() => {
          document.querySelector('#motion-probe')?.remove();
          const lamp = document.querySelector('#status-lamp');
          if (lamp !== null) {
            lamp.dataset.state = ${JSON.stringify(before.previous)};
          }
        })()`);
        await expect(reduced.lampName === 'none', `reduced lamp animation: ${reduced.lampName}`);
        await expect(reduced.lampDuration === '0s', `reduced lamp duration: ${reduced.lampDuration}`);
        await expect(reduced.probeTransition === '0s', `reduced transition: ${reduced.probeTransition}`);
        await expect(reduced.probeAnimation === 'none', `reduced probe animation: ${reduced.probeAnimation}`);
        return 'lamp pulse runs normally and is disabled under prefers-reduced-motion';
      },

      async perf() {
        const tokens = Array.from({ length: 64 }, (_, index) => index % 32).join(',');
        const lamp = await runWithValidInput({ tokens, seed: 7, fault: 'none' });
        await expect(lamp === 'pass', `64-token run did not pass: ${lamp}`);
        const elapsed = await evaluate('window.__lab.lastRunMs');
        await expect(typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed < 200,
          `64-token UI run took ${elapsed}ms`);
        const compute = await text('#summary [data-field="compute"]');
        await expect(compute !== null && Number.isFinite(parseFloat(compute)), `compute field: ${compute}`);
        const note = await text('[data-copy="notGpuTime"]');
        await expect(note !== null && /not GPU/i.test(note), `compute note: ${note}`);
        await evaluate("document.querySelector('#capture')?.scrollIntoView({ block: 'center' })");
        await delay(120);
        await screenshot('dense.png');
        await runWithValidInput({ tokens: '1,4,2,8,3,9', seed: 7, fault: 'none' });
        return `64-token run ${Math.round(elapsed)} ms, under the 200 ms budget`;
      },

      async resources() {
        const sessionTransfer = await evaluate("performance.getEntriesByType('resource').reduce((sum,e)=>sum+e.transferSize,0)");
        // Budget one cold app load, not an unbounded number of intentional Worker reruns.
        // Global error/network listeners remain active across this navigation.
        await gotoApp();
        await expect(await evaluate('window.__resourceTimingOverflow === false'), 'resource timing buffer overflowed');
        const resources = await evaluate(`(() => {
          const entries = performance.getEntriesByType('resource').map((entry) => ({
            url: entry.name,
            bytes: entry.transferSize ?? 0,
          }));
          return {
            entries,
            total: entries.reduce((sum, entry) => sum + entry.bytes, 0),
            origin: location.origin,
          };
        })()`);
        const foreign = resources.entries.filter((entry) => !isLocalResource(entry.url, resources.origin));
        await expect(Array.isArray(resources.entries) && resources.entries.length >= 5,
          `only ${resources.entries.length} resource timing entries`);
        const hasStyles = resources.entries.some((entry) => /\/styles\.css$/.test(entry.url));
        const hasMain = resources.entries.some((entry) => /\/apps\/web\/src\/main\.js$/.test(entry.url));
        await expect(hasStyles && hasMain, 'stylesheet or entry module is missing from resource timing');
        const empty = resources.entries.filter((entry) => !(entry.bytes > 0));
        await expect(empty.length === 0,
          `resources without transfer bytes: ${empty.map((entry) => entry.url).join(', ')}`);
        await expect(resources.total >= 20000,
          `resource transfer ${resources.total} bytes is below the 20,000-byte floor`);
        await expect(foreign.length === 0, `foreign resources: ${foreign.map((entry) => entry.url).join(', ')}`);
        await expect(resources.total <= 2 * 1024 * 1024, `resource transfer ${resources.total} bytes`);
        await expect(externalRequests.length === 0, `external requests: ${externalRequests.join(', ')}`);
        await expect(exceptions.length === 0, `page exceptions: ${exceptions.join(' | ')}`);
        await expect(consoleErrors.length === 0, `console errors: ${consoleErrors.join(' | ')}`);
        return `${resources.entries.length} cold-load local resources, ${resources.total} bytes (2 MiB budget); prior reruns transferred ${sessionTransfer} bytes; no errors`;
      },
    };

    await gotoApp();
    await setViewport(1280, 900);
    for (const name of requested) {
      try {
        const detail = await handlers[name]();
        results.push({ name, ok: true, detail: detail ?? 'ok' });
      } catch (error) {
        results.push({
          name,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    if (cdp !== null) {
      try {
        await cdp.send('Browser.close');
      } catch {
        // The socket often closes before the reply.
      }
      cdp.close();
    }
    if (child !== null) {
      const exited = await waitForChildExit(child, 5000);
      if (!exited) {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
        await waitForChildExit(child, 2000);
      }
    }
    browserStartup?.dispose();
    if (server !== null) {
      await closeServer(server);
    }
    if (profile.length > 0) {
      await removeProfile(profile);
    }
  }

  const summary = summarizeReport(requested, results);

  return {
    ...summary,
    results,
    screenshots,
    userAgent,
  };
}

function parseArgs(argv) {
  let sections = SECTIONS;
  for (const arg of argv) {
    if (arg.startsWith('--only=')) {
      const names = arg.slice('--only='.length).split(',').map((name) => name.trim()).filter(Boolean);
      if (names.length === 0) {
        throw new Error('--only requires at least one section name');
      }
      sections = names;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { sections };
}

if (process.argv[1] !== undefined) {
  const invokedDirectly = import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  if (invokedDirectly) {
    const { sections } = parseArgs(process.argv.slice(2));
    try {
      const report = await runE2E({ sections });
      const record = { ...report, generatedAt: new Date().toISOString() };
      writeFileSync(path.join(ARTIFACTS, 'e2e.json'), `${JSON.stringify(record, null, 2)}\n`);
      for (const result of report.results) {
        console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.detail}`);
      }
      const passed = report.results.filter((result) => result.ok).length;
      console.log(
        `e2e: ${report.ok ? 'PASS' : report.full ? 'FAIL' : 'PARTIAL'} (${passed}/${report.results.length} requested sections; full acceptance set is ${SECTIONS.length})`,
      );
      if (!report.full) {
        console.log('partial runs are for debugging only and are not acceptance evidence');
      }
      process.exitCode = report.ok ? 0 : 1;
    } catch (error) {
      mkdirSync(ARTIFACTS, { recursive: true });
      const detail = error instanceof Error ? error.message : String(error);
      const record = {
        ok: false,
        full: false,
        requested: sections,
        executed: [],
        results: [{ name: 'harness', ok: false, detail }],
        screenshots: [],
        userAgent: 'unknown',
        generatedAt: new Date().toISOString(),
      };
      writeFileSync(path.join(ARTIFACTS, 'e2e.json'), `${JSON.stringify(record, null, 2)}\n`);
      console.error(`e2e harness failed: ${detail}`);
      process.exitCode = 1;
    }
  }
}
