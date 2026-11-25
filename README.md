# Genesys Cloud OAuth connector

**[▶ Open the Genesys Cloud API Console](https://jcliff01.github.io/oauth-connector/)** · [Troubleshooting APIs](https://jcliff01.github.io/oauth-connector/troubleshooting.html)

No install needed: open the console, pick your region's token URL, enter your
PKCE client ID, and select **Connect to Genesys Cloud**.

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

## Browser console

The Connection form accepts a token name (a local label), grant type, regional
access token URL, client ID, and client secret. For US East, the token URL is
`https://login.mypurecloud.com/oauth/token`. Register the exact callback URI
shown below the form in your Genesys Cloud OAuth client.

- **Authorization Code with PKCE** runs on static HTTPS hosting, including
  GitHub Pages. The secret field is disabled.
- **Authorization Code** uses the client secret and requires the bundled Node.js
  server. Start it with `node server.js` and open `http://localhost:8080/`.
  For HTTPS hosting behind a reverse proxy, set `PORTAL_ORIGIN` to the public
  origin (for example `https://portal.example.com`) and expose the portal
  at the root of that origin. Route requests to a single Node.js instance
  so each authorization callback reaches the process holding its pending grant.
  The server clears pending client secrets after exchange or within ten minutes.

- **Client Credentials** uses the same Node.js server and sends the client ID
  and secret to the regional token endpoint as HTTP Basic authentication.
  Select a Genesys Cloud OAuth client configured for Client Credentials, with
  the roles and divisions required by your API requests. Scope is optional.
  This grant has no callback URL. The console checks its access using
  `GET /api/v2/organizations/me`. If this returns 403, the token may still
  be usable for endpoints allowed by that client's roles.

For user sign-in grants, the console verifies the session via `GET /api/v2/users/me`.
Tokens stay in browser memory for the console session. Use the request form to
send API Explorer paths and optional JSON request bodies.

## Project status

This is a development connector and example console. Validate the OAuth configuration and requested scopes in a development organization before using it with production accounts. Remove tokens, session cookies, and tenant identifiers from shared logs.

## License

Project code is available under the [MIT License](LICENSE).
