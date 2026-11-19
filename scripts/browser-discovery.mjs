import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

const WINDOWS_BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const MAC_BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];
const LINUX_COMMANDS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Return existing executable paths in launch order, never shell command strings.
 * LAB_BROWSER is exclusive (even an empty/invalid override must fail). `exists`
 * is the filesystem boundary for platform-independent discovery tests.
 */
export function browserCandidates({ platform = process.platform, env = process.env, exists = isExecutable } = {}) {
  if (env.LAB_BROWSER !== undefined) {
    const override = env.LAB_BROWSER;
    const paths = platform === 'win32' ? path.win32 : path.posix;
    if (typeof override !== 'string' || override.trim().length === 0) {
      throw new Error('LAB_BROWSER must be a non-empty browser executable path');
    }
    const executable = paths.isAbsolute(override) ? override : paths.resolve(override);
    if (!exists(executable)) {
      throw new Error(`LAB_BROWSER is not an existing executable file: ${override}`);
    }
    return [executable];
  }

  let candidates = [];
  if (platform === 'win32') {
    candidates = WINDOWS_BROWSERS;
  } else if (platform === 'darwin') {
    candidates = MAC_BROWSERS;
  } else if (platform === 'linux') {
    // Resolve PATH directly: no `which`, shell expansion, quoting or assumed
    // runner installation path. Ignore cwd/relative entries for CI safety.
    const directories = (env.PATH ?? '').split(':').filter((directory) => path.posix.isAbsolute(directory));
    candidates = LINUX_COMMANDS.flatMap((command) => directories.map((directory) => path.posix.join(directory, command)));
  }
  const installed = [...new Set(candidates)].filter((candidate) => exists(candidate));
  if (installed.length === 0) {
    throw new Error(`No Chromium browser found on ${platform}; set LAB_BROWSER to a browser executable`);
  }
  return installed;
}
