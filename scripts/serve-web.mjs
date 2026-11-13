import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ROOT = path.join(PROJECT_ROOT, 'apps', 'web', 'dist');

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.map', 'application/json; charset=utf-8'],
]);

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

/**
 * Maps a URL path to a regular file under root, or null. Rejects traversal,
 * backslashes, NUL bytes, drive letters, protocol-relative paths, dotfile
 * segments (including .env and .git), directories, and any candidate whose
 * real path escapes root through a symlink. Root is an absolute directory
 * path.
 */
export function resolveRequestPath(root, requestPath) {
  if (typeof requestPath !== 'string' || !requestPath.startsWith('/')) {
    return null;
  }
  if (requestPath.includes('\u0000') || requestPath.includes('\\')) {
    return null;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes('\u0000') || decoded.includes('\\') || decoded.startsWith('//')) {
    return null;
  }
  if (/^[A-Za-z]:/.test(decoded)) {
    return null;
  }
  const segments = decoded.split('/').filter((segment) => segment !== '');
  if (segments.some((segment) => segment.startsWith('.'))) {
    return null;
  }
  const resolvedRoot = path.resolve(root);
  const relative = segments.length === 0 ? 'index.html' : segments.join('/');
  const candidate = path.resolve(resolvedRoot, relative);
  const relation = path.relative(resolvedRoot, candidate);
  if (relation === '' || relation.startsWith('..') || path.isAbsolute(relation)) {
    return null;
  }
  try {
    const realRoot = realpathSync(resolvedRoot);
    const realCandidate = realpathSync(candidate);
    const realRelation = path.relative(realRoot, realCandidate);
    if (realRelation === '' || realRelation.startsWith('..') || path.isAbsolute(realRelation)) {
      return null;
    }
    return statSync(realCandidate).isFile() ? realCandidate : null;
  } catch {
    return null;
  }
}

function sendHead(response, status, extra = {}) {
  response.writeHead(status, { ...SECURITY_HEADERS, ...extra });
}

/**
 * A fixed-root static server. GET and HEAD only; every response carries the
 * same security headers. It is a development and demo server, not a general
 * file server.
 */
export function createStaticServer(root) {
  const resolvedRoot = path.resolve(root);
  return http.createServer((request, response) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendHead(response, 405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Method Not Allowed\n');
        return;
      }
      let pathname;
      try {
        pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      } catch {
        sendHead(response, 400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Bad Request\n');
        return;
      }
      const file = resolveRequestPath(resolvedRoot, pathname);
      if (file === null) {
        sendHead(response, 404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not Found\n');
        return;
      }
      const body = readFileSync(file);
      const contentType = CONTENT_TYPES.get(path.extname(file).toLowerCase())
        ?? 'application/octet-stream';
      sendHead(response, 200, {
        'Content-Type': contentType,
        'Content-Length': String(body.length),
        'Cache-Control': 'no-store',
      });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      response.end(body);
    } catch {
      if (!response.headersSent) {
        sendHead(response, 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      response.end('Internal Server Error\n');
    }
  });
}

if (process.argv[1] !== undefined) {
  const invokedDirectly = import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  if (invokedDirectly) {
    if (!existsSync(path.join(DEFAULT_ROOT, 'index.html'))) {
      console.error('apps/web/dist/index.html is missing; run node scripts/build-web.mjs first');
      process.exit(1);
    }
    const port = Number(process.env.PORT ?? 4173);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error('PORT must be an integer in [0, 65535]');
      process.exit(1);
    }
    const server = createStaticServer(DEFAULT_ROOT);
    server.on('error', (error) => {
      console.error(`web server failed: ${error.message}`);
      process.exit(1);
    });
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address !== null ? address.port : port;
      console.log(`serving apps/web/dist at http://127.0.0.1:${actualPort}/`);
    });
  }
}
