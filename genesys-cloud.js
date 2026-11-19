import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const regionDomains = new Set([
  'mypurecloud.com', 'usw2.pure.cloud', 'cac1.pure.cloud',
  'sae1.pure.cloud', 'mxc1.pure.cloud', 'mypurecloud.ie', 'mypurecloud.de',
  'euw2.pure.cloud', 'euc2.pure.cloud', 'mec1.pure.cloud',
  'aps1.pure.cloud', 'apse1.pure.cloud', 'mypurecloud.com.au',
  'mypurecloud.jp', 'apne2.pure.cloud', 'apne3.pure.cloud',
  'use2.us-gov-pure.cloud', 'edee1.eusc-pure.cloud',
]);

export class GenesysCloudError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GenesysCloudError';
    this.status = status;
  }
}

export function createGenesysCloudConnector({
  clientId, redirectUri, region, scopes = [],
}) {
  if (typeof clientId !== 'string' || !clientId.trim()) {
    throw new TypeError('Set a Genesys Cloud OAuth client ID');
  }
  if (!regionDomains.has(region)) {
    throw new TypeError('Set a supported Genesys Cloud region domain');
  }

  const callback = new URL(redirectUri);
  const localHttp = callback.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname);
  if ((!localHttp && callback.protocol !== 'https:')
      || callback.username || callback.password || callback.hash || callback.search) {
    throw new TypeError('Use an HTTPS callback or loopback HTTP URL without credentials, query, or fragment');
  }

  const login = `https://login.${region}`;
  const api = `https://api.${region}`;
  const scope = scopes.join(' ');

  function beginAuthorization() {
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = new URL('/oauth/authorize', login);
    url.search = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    if (scope) url.searchParams.set('scope', scope);

    return {
      authorizationUrl: url.href,
      transaction: { state, verifier, expiresAt: Date.now() + 10 * 60_000 },
    };
  }

  async function exchangeCode(query, transaction) {
    const states = query.getAll('state');
    const received = Buffer.from(states[0] ?? '');
    const expected = Buffer.from(transaction?.state ?? '');
    if (!transaction || transaction.expiresAt <= Date.now()
        || states.length !== 1 || expected.length === 0
        || received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new GenesysCloudError('Invalid or expired OAuth transaction', 400);
    }
    if (query.has('error')) {
      throw new GenesysCloudError('Genesys Cloud authorization was declined or failed', 400);
    }
    const codes = query.getAll('code');
    if (codes.length !== 1 || !codes[0]) {
      throw new GenesysCloudError('Missing or invalid authorization code', 400);
    }

    const response = await fetch(`${login}/oauth/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code: codes[0],
        code_verifier: transaction.verifier,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new GenesysCloudError('Genesys Cloud token exchange failed', response.status);
    }
    const token = await response.json();
    if (typeof token.access_token !== 'string' || !token.access_token
        || token.token_type?.toLowerCase() !== 'bearer'
        || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
      throw new GenesysCloudError('Invalid token response from Genesys Cloud', 502);
    }
    return { accessToken: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
  }

  async function request(token, path, { method = 'GET', query, body } = {}) {
    const url = new URL(path, api);
    if (url.origin !== api || !url.pathname.startsWith('/api/v2/')
        || !path.startsWith('/api/v2/') || url.search || url.hash
        || /[%\\]/.test(path)) {
      throw new TypeError('Use a relative Genesys Cloud /api/v2/ path and pass query parameters separately');
    }
    if (!token?.accessToken || !(token.expiresAt > Date.now())) {
      throw new GenesysCloudError('Genesys Cloud sign-in required', 401);
    }

    if (query) url.search = new URLSearchParams(query);
    const headers = { Authorization: `Bearer ${token.accessToken}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new GenesysCloudError('Genesys Cloud API request failed', response.status);
    }
    const content = await response.text();
    return content ? JSON.parse(content) : undefined;
  }

  return {
    beginAuthorization,
    exchangeCode,
    request,
    getCurrentUser: (token) => request(token, '/api/v2/users/me'),
  };
}
