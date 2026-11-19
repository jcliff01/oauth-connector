import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { parseTokenUrl } from './oauth-regions.js';

const port = Number(process.env.PORT ?? 8080);
const origin = new URL(process.env.PORTAL_ORIGIN ?? `http://localhost:${port}`);
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
if (origin.href !== origin.origin + '/' || (!loopback && origin.protocol !== 'https:')
    || !['http:', 'https:'].includes(origin.protocol)) {
  throw new Error('PORTAL_ORIGIN must be an HTTPS origin or a loopback HTTP origin.');
}

const ttl = 600_000;
const pending = new Map();
const callbacks = new Set(['/', '/index.html'].map(path => new URL(path, origin).href));
const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/index.html', ['index.html', 'text/html']],
  ['/console.css', ['console.css', 'text/css']],
  ['/console.js', ['console.js', 'text/javascript']],
  ['/oauth-regions.js', ['oauth-regions.js', 'text/javascript']],
]);

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) {
      req.destroy();
      throw new Error('Request body is too large.');
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function begin(res, input) {
  const { tokenUrl, clientId, clientSecret, redirectUri, state } = input;
  if (!callbacks.has(redirectUri) || typeof clientId !== 'string'
      || !clientId || clientId.includes(':') || typeof clientSecret !== 'string'
      || !clientSecret || typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
    return json(res, 400, { error: 'Check the client ID, secret, and callback URI.' });
  }
  try {
    parseTokenUrl(tokenUrl);
  } catch {
    return json(res, 400, { error: 'Enter a supported Genesys Cloud token URL.' });
  }
  if (pending.size >= 256) {
    return json(res, 503, { error: 'Too many pending sign-ins. Try again shortly.' });
  }
  const ticket = randomBytes(32).toString('base64url');
  const timer = setTimeout(() => pending.delete(ticket), ttl);
  timer.unref();
  pending.set(ticket, { tokenUrl, clientId, clientSecret, redirectUri, state, timer, expiresAt: Date.now() + ttl });
  return json(res, 200, { ticket });
}

async function exchange(res, { ticket, code, state }) {
  const grant = pending.get(ticket);
  if (!grant || grant.expiresAt <= Date.now() || state !== grant.state
      || typeof code !== 'string' || !code) {
    return json(res, 400, { error: 'This sign-in expired or could not be verified. Connect again.' });
  }
  pending.delete(ticket);
  clearTimeout(grant.timer);

  try {
    const basic = Buffer.from(`${grant.clientId}:${grant.clientSecret}`).toString('base64');
    const response = await fetch(grant.tokenUrl, {
      method: 'POST', headers: { Authorization: `Basic ${basic}` },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: grant.redirectUri,
      }),
      signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (!response.ok) {
      return json(res, 502, { error: `Genesys Cloud rejected the token exchange (HTTP ${response.status}). Check the client ID, secret, and callback URI.` });
    }
    const { access_token, token_type, expires_in } = await response.json();
    return json(res, 200, { access_token, token_type, expires_in });
  } catch {
    return json(res, 502, { error: 'Could not complete the token exchange with Genesys Cloud.' });
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const path = req.url.split('?')[0];
  if (req.method === 'GET' && path === '/oauth/code') {
    return json(res, 200, { authorizationCode: true });
  }
  if (req.method === 'POST' && path === '/oauth/code') {
    if (req.headers.origin !== origin.origin || req.headers['content-type'] !== 'application/json') {
      return json(res, 403, { error: 'Use the configured portal origin.' });
    }
    try {
      const input = await readJson(req);
      if (input?.action === 'begin') return begin(res, input);
      if (input?.action === 'exchange') return await exchange(res, input);
    } catch {
      // Return a generic error without exposing request content.
    }
    if (!res.destroyed) return json(res, 400, { error: 'Invalid OAuth request.' });
    return;
  }

  if (req.method !== 'GET' || !assets.has(path)) {
    return json(res, 404, { error: 'Not found.' });
  }
  const [file, type] = assets.get(path);
  try {
    const content = await readFile(new URL(file, import.meta.url));
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
    res.end(content);
  } catch {
    json(res, 500, { error: 'The portal file could not be loaded.' });
  }
});

server.listen(port, process.env.HOST ?? '127.0.0.1', () => {
  console.log(`Genesys Cloud API Console: ${origin.origin}`);
});
