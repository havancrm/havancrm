// Sync + backup server. Also serves the mobile web app (PWA) from ../app.
// Usage: SYNC_TOKEN=secret PORT=8080 node server/server.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileStore, COLLECTIONS, applyChanges, changesSince } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(here, '..', 'app');
const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.SYNC_TOKEN || '';
const store = new FileStore(process.env.DATA_DIR || path.join(here, 'data'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, {
    'content-type': type,
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function authorized(req) {
  return !TOKEN || req.headers.authorization === `Bearer ${TOKEN}`;
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });

  if (url.pathname === '/api/sync' && req.method === 'POST') {
    const { since = 0, changes = {} } = JSON.parse((await readBody(req)) || '{}');
    const result = {};
    const accepted = applyChanges(store.state, changes, result);
    if (accepted) await store.save();
    return send(res, 200, {
      cursor: store.state.seq,
      accepted,
      acceptedIds: result.acceptedIds,
      conflicts: result.conflicts,
      supports: COLLECTIONS,
      changes: changesSince(store.state, since),
    });
  }
  if (url.pathname === '/api/backup' && req.method === 'POST') {
    const file = await store.backup();
    return send(res, 200, { ok: true, file: path.basename(file) });
  }
  if (url.pathname === '/api/health') return send(res, 200, { ok: true, seq: store.state.seq });
  return send(res, 404, { error: 'not found' });
}

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(APP_DIR, rel));
  if (!file.startsWith(APP_DIR)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
});

// Daily snapshot backup of the server database.
store.backup().catch(() => {});
setInterval(() => store.backup().catch(() => {}), 6 * 60 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`ART CRM server: http://localhost:${PORT}${TOKEN ? ' (token required)' : ''}`);
});
