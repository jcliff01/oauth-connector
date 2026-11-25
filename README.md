# Genesys Cloud OAuth connector and API console

Two things in one repository:

- **An API console** you open in a web browser. You sign in to Genesys Cloud, then send requests to the Genesys Cloud Platform API and see the answers, without writing any code.
- **A small code module** (`genesys-cloud.js`) that lets a website sign its users in to Genesys Cloud and call the API for them. It uses OAuth 2.0 Authorization Code with PKCE, and keeps tokens on the server.

> **Status: development tool.** Try it with a development or test Genesys Cloud organization before using it with production accounts.

## Before you start: an OAuth client in Genesys Cloud

A Genesys Cloud administrator creates the OAuth client the console signs in with:

1. In Genesys Cloud, go to **Admin → IT and Integrations → OAuth** and click **Add Client** ([Genesys guide](https://help.genesys.cloud/articles/create-an-oauth-client/)).
2. Choose the **Grant Type**:
   - **Code Authorization / PKCE**: to sign in as yourself. Works in the online console with nothing installed.
   - **Code Authorization** or **Client Credentials**: these use a client secret, so they need the console running on your own computer (see "Option 2").
3. For the two sign-in grants, add the **callback URL** the console shows under the form to **Authorized redirect URIs**, exactly as shown, including the final `/`.
4. Give it only the scopes (or, for Client Credentials, the roles) your requests need. Note the **Client ID**.

You also need your organization's **region**: the address you sign in at, such as `mypurecloud.com` (US East) or `apse1.pure.cloud` (Singapore). The console asks for the token URL, which is `https://login.<region>/oauth/token`, for example `https://login.mypurecloud.com/oauth/token`.

## Option 1: Use the console online (no install)

1. Open **[jcliff01.github.io/oauth-connector](https://jcliff01.github.io/oauth-connector/)**.
2. Leave **Grant type** on **Authorization Code with PKCE**.
3. Enter the **Access token URL** and **Client ID**, then click **Connect to Genesys Cloud** and sign in.
4. In **API request**, choose a method, type a path such as `/api/v2/users/me`, and click **Send request**. The [API Explorer](https://developer.genesys.cloud/devapps/api-explorer) lists every path.

Your token stays in that browser tab only and is forgotten when you close it. The online console can't use a client secret, so the other grant types are greyed out there.

## Option 2: Run the console on your computer

Needed for the **Authorization Code** and **Client Credentials** grants, which use a client secret.

### 1. Install Node.js 22 or newer

| Computer | How |
| --- | --- |
| Windows | In PowerShell: `winget install OpenJS.NodeJS.LTS` |
| macOS | Download the installer from [nodejs.org](https://nodejs.org/) and run it, or `brew install node` |
| Linux | Download from [nodejs.org](https://nodejs.org/en/download), or use your package manager if it offers version 22 or newer |

Open a new terminal and check: `node --version` should print v22 or higher.

### 2. Get the code

Click the green **Code** button on this page, choose **Download ZIP** and unzip it, or run `git clone https://github.com/jcliff01/oauth-connector.git`. Open a terminal in that folder.

### 3. Start it

```sh
npm start
```

Then open **http://localhost:8080/** in your browser. Register `http://localhost:8080/` as the callback URL in your OAuth client (for the Authorization Code grant). Press **Ctrl+C** in the terminal to stop it. It has nothing to install: the code uses only what comes with Node.js.

The server only answers this computer. To use a different port, set `PORT` first: `$env:PORT=8090` in Windows PowerShell, or `export PORT=8090` on macOS and Linux.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| Genesys shows an error before sending you back | The callback URL in the OAuth client must match the one under the form exactly, including the final `/`. Check the Client ID, region and grant type. |
| "Enter a supported Genesys Cloud token URL" | Use `https://login.<region>/oauth/token`, for example `https://login.mypurecloud.com/oauth/token`. |
| Grant types greyed out | You're on the online console. Use Option 2 for grants with a secret. |
| `403` from a request | You're signed in, but the OAuth client's scopes or roles don't allow that request. |
| `npm` or `node` not recognized | Open a new terminal after installing Node.js. |

The console's **[troubleshooting page](https://jcliff01.github.io/oauth-connector/troubleshooting.html)** covers more Genesys error messages.

## For developers: the connector module

`genesys-cloud.js` signs your website's users in with Authorization Code + PKCE and calls the API with their token. It needs Node.js 22+ and nothing else.

```js
import { createGenesysCloudConnector } from './genesys-cloud.js';

const genesys = createGenesysCloudConnector({
  clientId: process.env.GENESYS_CLIENT_ID,
  region: process.env.GENESYS_REGION,            // for example mypurecloud.com
  redirectUri: process.env.GENESYS_REDIRECT_URI, // your callback route, registered in the OAuth client
});
```

1. **Connect route:** call `genesys.beginAuthorization()`. Save the returned `transaction` in the visitor's server-side session and redirect them to `authorizationUrl`.
2. **Callback route:** take the pending transaction out of the session (and remove it), then call `await genesys.exchangeCode(new URLSearchParams(query), transaction)`. Store the returned token in the user's server-side session and redirect to a clean URL.
3. **API calls:** `await genesys.getCurrentUser(token)` returns the signed-in user. `await genesys.request(token, '/api/v2/...', { method, query, body })` calls any other endpoint. Decide the path and method in your server code, never from user input.
4. **Expired or rejected (HTTP 401):** clear the token and start again at step 1. To sign out, remove the token and any pending transaction from the session.

Use an opaque session cookie with `HttpOnly` and `SameSite=Lax` (so it is sent on the sign-in callback), and `Secure` on HTTPS. Use HTTPS everywhere but local development. Keep tokens, PKCE verifiers and callback query strings out of logs and browser responses.

**Hosting the console server behind a reverse proxy:** set `PORTAL_ORIGIN` to its public HTTPS address (for example `https://portal.example.com`), serve it at the root of that address, and send all requests to one Node.js process, because each sign-in's pending state lives in that process's memory (for at most ten minutes).

## License

[MIT](LICENSE).
