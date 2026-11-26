import { parseTokenUrl, regions } from './oauth-regions.js';

const transactionKey = 'genesys-api-console:oauth';
const byId = (id) => document.getElementById(id);
const pageUri = new URL(location.pathname, location.origin).href;
const githubPages = location.hostname.endsWith('.github.io');
const redirectUri = githubPages ? new URL('./', import.meta.url).href : pageUri;
const tokenNameInput = byId('token-name');
const grantInput = byId('grant');
const tokenUrlInput = byId('token-url');
const secretInput = byId('secret');
const scopeInput = byId('scope');
let credentialsAvailable = false;
const codeEndpoint = './oauth/code';
let confidentialAvailable = false;
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
  const credentials = credentialsAvailable && grantInput.value === 'credentials';
  secretInput.disabled = locked || !(credentials || (confidentialAvailable && grantInput.value === 'code'));
  scopeInput.disabled = locked || !credentials;
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
  const endpoint = connection.grant === 'credentials' ? '/api/v2/organizations/me' : '/api/v2/users/me';
  const { response, parsed } = await sendRequest(endpoint);
  if (connection && response.ok && typeof parsed?.id === 'string') {
    setStatus(`Verified · ${connection.name} · ${parsed.name || parsed.id} · ${connection.region}`);
  } else if (connection && response.status !== 401) {
    setStatus(`Connection verification failed (HTTP ${response.status}). Check the OAuth client’s roles, scopes, or user permissions.`);
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
  const confidential = confidentialAvailable && grantInput.value === 'code';
  const credentials = credentialsAvailable && grantInput.value === 'credentials';
  secretInput.required = confidential || credentials;
  if (!secretInput.required) secretInput.value = '';
  byId('scope-field').hidden = !credentials;
  copyCallback.hidden = credentials;
  byId('grant-help').textContent = confidential
    ? `Register ${redirectUri} as the callback URI. This grant requires the Node.js portal server.`
    : credentials
      ? 'The client ID and secret are sent as a Basic Auth header. Client Credentials uses no callback URL.'
      : `In your Genesys Cloud OAuth client, choose Code Authorization / PKCE and add ${redirectUri} under Authorized redirect URIs. Use that client’s ID and your organization’s regional token URL.`;
  syncControls();
}

const copyCallback = document.createElement('button');
copyCallback.type = 'button';
copyCallback.textContent = 'Copy callback URL';
byId('grant-help').after(copyCallback);
copyCallback.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(redirectUri);
    setStatus('Callback URL copied.');
  } catch {
    setStatus(`Copy this callback URL manually: ${redirectUri}`);
  }
});

grantInput.addEventListener('change', syncGrant);
syncGrant();

async function detectConfidentialGrant() {
  if (githubPages) return;
  try {
    const response = await fetch(codeEndpoint, {
      headers: { Accept: 'application/json' }, redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok || !response.headers.get('Content-Type')?.startsWith('application/json')) return;
    const capability = await response.json();
    if (capability.authorizationCode !== true) return;
    confidentialAvailable = true;
    const option = byId('code-grant');
    option.disabled = false;
    option.textContent = 'Authorization Code';
    credentialsAvailable = capability.clientCredentials === true;
    if (credentialsAvailable) {
      const option = byId('credentials-grant');
      option.disabled = false;
      option.textContent = 'Client Credentials';
    }
    syncGrant();
  } catch {
    // Static hosts continue to offer PKCE if the backend is unavailable.
  }
}

void detectConfidentialGrant();

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
    const grant = grantInput.value;
    const name = tokenNameInput.value.trim() || 'Genesys Cloud';
    if (grant === 'credentials') {
      if (!credentialsAvailable) throw new Error('Client Credentials requires the Node.js portal server.');
      const clientSecret = secretInput.value;
      secretInput.value = '';
      const token = await confidentialRequest({
        action: 'credentials', tokenUrl, clientId, clientSecret, scope: scopeInput.value.trim(),
      });
      await activateConnection(token, { region: parseTokenUrl(tokenUrl).region, name, grant });
      return;
    }
    const state = randomValue();
    const transaction = { tokenUrl, clientId, redirectUri, state, grant, name, expiresAt: Date.now() + 600_000 };
    authorizationUrl.search = new URLSearchParams({
      client_id: clientId, response_type: 'code', redirect_uri: redirectUri, state,
    });
    if (grant === 'code') {
      if (!confidentialAvailable) throw new Error('Select Authorization Code with PKCE on this host.');
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
      code, code_verifier: transaction.verifier, redirect_uri: transaction.redirectUri ?? pageUri,
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
  await activateConnection(token, { region, name: transaction.name, grant: transaction.grant });
}

async function activateConnection(token, { region, name, grant }) {
  if (typeof token.access_token !== 'string' || !token.access_token
      || typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer'
      || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
    throw new Error('Genesys Cloud returned an invalid token response.');
  }
  connection = { region, name, grant, token: token.access_token };
  expirationTimer = setTimeout(() => {
    clearConnection();
    setStatus('Session expired. Connect again.');
  }, token.expires_in * 1000);
  if (grant === 'credentials' && byId('path').value === '/api/v2/users/me') {
    byId('path').value = '/api/v2/organizations/me';
  }
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

// A request chosen on the troubleshooting page, kept in this tab so it survives sign-in.
const draftKey = 'genesys-api-console:draft';
try {
  const draft = JSON.parse(sessionStorage.getItem(draftKey) ?? 'null');
  if (draft && [...methodInput.options].some(o => o.value === draft.method) && typeof draft.path === 'string') {
    methodInput.value = draft.method;
    byId('path').value = draft.path;
    byId('body').value = typeof draft.body === 'string' ? draft.body : '';
  }
} catch { /* Ignore a malformed draft. */ }
function saveDraft() {
  sessionStorage.setItem(draftKey, JSON.stringify({
    method: methodInput.value, path: byId('path').value, body: byId('body').value,
  }));
}
for (const input of [methodInput, byId('path'), byId('body')]) input.addEventListener('input', saveDraft);

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
  history.replaceState(null, '', pageUri);
  setStatus('Completing sign-in…');
  run(() => handleCallback(callback), setStatus);
}
