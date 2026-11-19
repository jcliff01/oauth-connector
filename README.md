# Genesys Cloud OAuth connector

A dependency-free Node.js 22+ module for websites that call the Genesys Cloud
Platform API on behalf of a signed-in user. It implements OAuth 2.0
Authorization Code with S256 PKCE. Tokens stay in the website backend.

## Configure Genesys Cloud

In [IT and Integrations → OAuth](https://help.genesys.cloud/articles/create-an-oauth-client/),
register a **PKCE** client and add the exact callback URL used by your website.
Choose the smallest set of scopes required by the endpoints you plan to call.
Use your organization's [region domain](https://help.genesys.cloud/?p=162751),
such as `mypurecloud.com` for US East or `apse1.pure.cloud` for Singapore.

## Wire up your backend

```js
import { createGenesysCloudConnector } from './genesys-cloud.js';

const genesys = createGenesysCloudConnector({
  clientId: process.env.GENESYS_CLIENT_ID,
  region: process.env.GENESYS_REGION,
  redirectUri: process.env.GENESYS_REDIRECT_URI,
});
```

1. **Connect route.** Call `genesys.beginAuthorization()`. Save the returned
   `transaction` in the visitor's server-side session, then redirect the visitor
   to `authorizationUrl`.
2. **Callback route.** Atomically take and remove the pending transaction from
   the same session. Pass the callback query as a `URLSearchParams` and the
   transaction to `await genesys.exchangeCode(query, transaction)`. Store the
   returned token in that user's server-side session and redirect to a clean URL.
3. **API calls.** Pass the session token to `await genesys.getCurrentUser(token)`
   to retrieve the current profile. Use `genesys.request(token, '/api/v2/...')`
   for other endpoints. It accepts an optional third argument with `method`,
   `query`, and a JSON `body`. Choose the endpoint and method in backend code
   before calling the connector.
4. **Reconnect and disconnect.** When the token expires or Genesys rejects it
   with HTTP 401, clear it and start a fresh authorization flow. To disconnect
   locally, remove the token and any pending transaction from the session.

Use an opaque session cookie with HttpOnly and SameSite=Lax so it is sent on
the top-level OAuth callback. Set Secure for HTTPS. Use HTTPS outside local
development. Keep token values, PKCE verifiers, and callback query strings
out of application logs and browser responses.
