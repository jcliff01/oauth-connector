import { parseTokenUrl, regions } from './oauth-regions.js';

const transactionKey = 'genesys-api-console:oauth';
const byId = (id) => document.getElementById(id);
const redirectUri = new URL(location.pathname, location.origin).href;
const tokenNameInput = byId('token-name');
const grantInput = byId('grant');
const tokenUrlInput = byId('token-url');
const secretInput = byId('secret');
const codeEndpoint = './oauth/code';
const clientInput = byId('client');
const methodInput = byId('method');
let connection;
let expirationTimer;
let busy = false;

for (const region of regions) {
  const option = document.createElement('option');
  option.value = `https://login.${region}/oauth/token`;
  byId('token-urls').append(option);
}

function randomValue() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64Url(bytes);
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function setStatus(message) {
  byId('status').textContent = message;
}

function syncControls() {
  byId('sign-in').disabled = busy || Boolean(connection);
  byId('verify').disabled = busy || !connection;
  byId('disconnect').disabled = busy || !connection;
  byId('send').disabled = busy || !connection;
  const locked = busy || Boolean(connection);
  for (const input of [tokenNameInput, grantInput, tokenUrlInput, clientInput]) {
    input.disabled = locked;
  }
  secretInput.disabled = locked || grantInput.value !== 'code';
}

function clearConnection() {
  connection = undefined;
  clearTimeout(expirationTimer);
  syncControls();
}

function showResponse(status, body = '') {
  byId('response-status').textContent = status;
  byId('output').textContent = body;
}

function apiUrl(path) {
  if (!/^\/api\/v2\/[^?#]+/.test(path) || /[\\#\u0000-\u001f]/.test(path)) {
    throw new Error('Enter a Platform API path beginning with /api/v2/.');
  }
  const origin = `https://api.${connection.region}`;
  const url = new URL(path, origin);
  if (url.origin !== origin || !url.pathname.startsWith('/api/v2/')) {
    throw new Error('The request must stay on the connected Genesys Cloud Platform API.');
  }
  return url;
}

async function sendRequest(path, method = 'GET', body) {
  const url = apiUrl(path);
  const headers = { Authorization: `Bearer ${connection.token}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const start = performance.now();
  const response = await fetch(url, {
    method, headers, body, redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  const raw = await response.text();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { /* Preserve text responses. */ }
  showResponse(
    `HTTP ${response.status} · ${Math.round(performance.now() - start)} ms`,
    raw ? (parsed === undefined ? raw : JSON.stringify(parsed, null, 2)) : '(empty body)',
  );
  if (response.status === 401) {
    clearConnection();
    setStatus('Genesys Cloud rejected the session. Connect again.');
  }
  return { response, parsed };
}

async function verify() {
  const { response, parsed } = await sendRequest('/api/v2/users/me');
  if (connection && response.ok && typeof parsed?.id === 'string') {
    setStatus(`Verified · ${connection.name} · ${parsed.name || parsed.id} · ${connection.region}`);
  } else if (connection && response.status !== 401) {
    setStatus(`Connection verification failed (HTTP ${response.status}). Check client scopes and user permissions.`);
  }
}

async function run(task, reportError) {
  busy = true;
  syncControls();
  try {
    await task();
  } catch (error) {
    reportError(error.message);
  } finally {
    busy = false;
    syncControls();
  }
}

function syncGrant() {
  const confidential = grantInput.value === 'code';
  secretInput.required = confidential;
  if (!confidential) secretInput.value = '';
  byId('grant-help').textContent = confidential
    ? `Register ${redirectUri} as the callback URI. This grant requires the Node.js portal server.`
    : `Register ${redirectUri} as the callback URI for your PKCE client.`;
  syncControls();
}

grantInput.addEventListener('change', syncGrant);
syncGrant();

async function confidentialRequest(payload) {
  const response = await fetch(codeEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  if (!response.headers.get('Content-Type')?.startsWith('application/json')) {
    throw new Error('Authorization Code requires the Node.js portal server.');
  }
  if (!response.ok) {
    const result = await response.json();
    throw new Error(result.error || `Authorization Code request failed (HTTP ${response.status}).`);
  }
  return response.json();
}

byId('connect').addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy || connection) return;
  run(async () => {
    const { tokenUrl, authorizationUrl } = parseTokenUrl(tokenUrlInput.value.trim());
    const clientId = clientInput.value.trim();
    if (!clientId) throw new Error('Enter your OAuth client ID.');
    if (!window.isSecureContext) throw new Error('Open this page over HTTPS or localhost.');
    const state = randomValue();
    const grant = grantInput.value;
    const name = tokenNameInput.value.trim() || 'Genesys Cloud';
    const transaction = { tokenUrl, clientId, state, grant, name, expiresAt: Date.now() + 600_000 };
    authorizationUrl.search = new URLSearchParams({
      client_id: clientId, response_type: 'code', redirect_uri: redirectUri, state,
    });
    if (grant === 'code') {
      const clientSecret = secretInput.value;
      secretInput.value = '';
      const { ticket } = await confidentialRequest({
        action: 'begin', tokenUrl, clientId, clientSecret, redirectUri, state,
      });
      transaction.ticket = ticket;
    } else {
      transaction.verifier = randomValue();
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(transaction.verifier));
      authorizationUrl.searchParams.set('code_challenge_method', 'S256');
      authorizationUrl.searchParams.set('code_challenge', base64Url(new Uint8Array(digest)));
    }
    sessionStorage.setItem(transactionKey, JSON.stringify(transaction));
    location.assign(authorizationUrl.href);
  }, setStatus);
});

async function exchangePkce(tokenUrl, transaction, code) {
  const response = await fetch(tokenUrl, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: transaction.clientId,
      code, code_verifier: transaction.verifier, redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) throw new Error(`Token exchange failed (HTTP ${response.status}). Check the PKCE client and callback URI.`);
  return response.json();
}

async function handleCallback(query) {
  const saved = sessionStorage.getItem(transactionKey);
  sessionStorage.removeItem(transactionKey);
  const transaction = JSON.parse(saved);
  if (!transaction || transaction.expiresAt <= Date.now()
      || query.getAll('state').length !== 1 || query.get('state') !== transaction.state) {
    throw new Error('This sign-in expired or could not be verified. Connect again.');
  }
  const { region, tokenUrl } = parseTokenUrl(transaction.tokenUrl);
  tokenNameInput.value = transaction.name;
  tokenUrlInput.value = tokenUrl;
  clientInput.value = transaction.clientId;
  grantInput.value = transaction.grant;
  syncGrant();
  if (query.has('error')) throw new Error('Genesys Cloud declined authorization.');
  if (query.getAll('code').length !== 1 || !query.get('code')) {
    throw new Error('Genesys Cloud did not return an authorization code.');
  }

  const code = query.get('code');
  const token = transaction.grant === 'code'
    ? await confidentialRequest({ action: 'exchange', ticket: transaction.ticket, state: transaction.state, code })
    : await exchangePkce(tokenUrl, transaction, code);
  if (typeof token.access_token !== 'string' || !token.access_token
      || typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer'
      || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
    throw new Error('Genesys Cloud returned an invalid token response.');
  }
  connection = { region, name: transaction.name, token: token.access_token };
  expirationTimer = setTimeout(() => {
    clearConnection();
    setStatus('Session expired. Connect again.');
  }, token.expires_in * 1000);
  setStatus('Checking connection…');
  await verify();
}

byId('verify').addEventListener('click', () => run(verify, setStatus));
byId('disconnect').addEventListener('click', () => {
  clearConnection();
  showResponse('Waiting for a request');
  setStatus('Disconnected');
});
function syncBodyField() {
  const isGet = methodInput.value === 'GET';
  byId('body').disabled = isGet;
  byId('body-help').textContent = isGet
    ? 'Select POST, PUT, PATCH, or DELETE to include a JSON body.'
    : 'Enter valid JSON or leave this blank to send the request without a body.';
}

methodInput.addEventListener('change', syncBodyField);
syncBodyField();
byId('request').addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy || !connection) return;

  run(async () => {
    const method = methodInput.value;
    const path = byId('path').value.trim();
    const json = byId('body').value.trim();
    apiUrl(path);
    let body;
    if (method !== 'GET') {
      if (json) body = JSON.stringify(JSON.parse(json));
      if (!window.confirm(`Send ${method} ${path} to ${connection.region}? This may modify Genesys Cloud data.`)) return;
    }
    showResponse('Sending request…');
    await sendRequest(path, method, body);
  }, showResponse);
});

const callback = new URLSearchParams(location.search);
if (callback.has('code') || callback.has('error') || callback.has('state')) {
  history.replaceState(null, '', redirectUri);
  setStatus('Completing sign-in…');
  run(() => handleCallback(callback), setStatus);
}
