const regions = new Set([
  'mypurecloud.com', 'usw2.pure.cloud', 'cac1.pure.cloud', 'sae1.pure.cloud',
  'mxc1.pure.cloud', 'mypurecloud.ie', 'mypurecloud.de', 'euw2.pure.cloud',
  'euc2.pure.cloud', 'mec1.pure.cloud', 'aps1.pure.cloud', 'apse1.pure.cloud',
  'mypurecloud.com.au', 'mypurecloud.jp', 'apne2.pure.cloud', 'apne3.pure.cloud',
  'use2.us-gov-pure.cloud', 'edee1.eusc-pure.cloud',
]);
const transactionKey = 'genesys-api-console:oauth';
const byId = (id) => document.getElementById(id);
const redirectUri = new URL(location.pathname, location.origin).href;
const regionInput = byId('region');
const clientInput = byId('client');
const methodInput = byId('method');
let connection;
let expirationTimer;
let busy = false;

byId('redirect').value = redirectUri;
for (const region of regions) {
  const option = document.createElement('option');
  option.value = region;
  byId('regions').append(option);
}

function regionFrom(input) {
  const value = input.trim().toLowerCase();
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  const region = url.hostname.replace(/^(apps|login|api)\./, '');
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !regions.has(region)) {
    throw new Error('Enter a supported Genesys Cloud region or instance URL.');
  }
  return region;
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
  regionInput.disabled = busy || Boolean(connection);
  clientInput.disabled = busy || Boolean(connection);
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
    setStatus(`Verified · ${parsed.name || parsed.id} · ${connection.region}`);
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

byId('connect').addEventListener('submit', (event) => {
  event.preventDefault();
  run(async () => {
    const region = regionFrom(regionInput.value);
    const clientId = clientInput.value.trim();
    if (!clientId) throw new Error('Enter your OAuth client ID.');
    if (!window.isSecureContext) throw new Error('Open this page over HTTPS or localhost.');
    const state = randomValue();
    const verifier = randomValue();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const url = new URL(`https://login.${region}/oauth/authorize`);
    url.search = new URLSearchParams({
      client_id: clientId, response_type: 'code', redirect_uri: redirectUri,
      state, code_challenge_method: 'S256', code_challenge: base64Url(new Uint8Array(digest)),
    });
    sessionStorage.setItem(transactionKey, JSON.stringify({
      region, clientId, state, verifier, expiresAt: Date.now() + 600_000,
    }));
    location.assign(url.href);
  }, setStatus);
});

async function handleCallback(query) {
  const saved = sessionStorage.getItem(transactionKey);
  sessionStorage.removeItem(transactionKey);
  const transaction = JSON.parse(saved);
  if (!transaction || transaction.expiresAt <= Date.now()
      || query.getAll('state').length !== 1 || query.get('state') !== transaction.state) {
    throw new Error('This sign-in expired or could not be verified. Connect again.');
  }
  const region = regionFrom(transaction.region);
  regionInput.value = region;
  clientInput.value = transaction.clientId;
  if (query.has('error')) throw new Error('Genesys Cloud declined authorization.');
  if (query.getAll('code').length !== 1 || !query.get('code')) {
    throw new Error('Genesys Cloud did not return an authorization code.');
  }

  const response = await fetch(`https://login.${region}/oauth/token`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: transaction.clientId,
      code: query.get('code'), code_verifier: transaction.verifier, redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) throw new Error(`Token exchange failed (HTTP ${response.status}). Check the PKCE client and redirect URI.`);
  const token = await response.json();
  if (typeof token.access_token !== 'string' || !token.access_token
      || typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer'
      || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
    throw new Error('Genesys Cloud returned an invalid token response.');
  }
  connection = { region, token: token.access_token };
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
